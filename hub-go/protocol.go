package main

// Port of packages/protocol/src/envelope.ts validation (see also android/engine). All three
// implementations are checked against packages/protocol/test/vectors.json.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	protocolVersion = 1
	hour            = int64(3_600_000)
	day             = 24 * hour
	maxFutureSkew   = day
	maxHaveIDs      = 5000
	maxMediaBytes   = 1_000_000
)

type rules struct {
	priority int
	maxBytes int
	maxTTL   int64
	powBits  int
}

var kindRules = map[string]rules{
	"sos":     {0, 1024, 3 * day, 10},
	"alert":   {0, 4096, 7 * day, 0},
	"dm":      {1, 256 * 1024, 30 * day, 12},
	"room":    {2, 8 * 1024, 14 * day, 12},
	"profile": {3, 2048, 365 * day, 10},
	"post":    {3, 256 * 1024, 60 * day, 14},
}

var (
	sealedFields = set("v", "kind", "ts", "exp", "to", "epk", "ct", "nonce", "id")
	signedFields = set("v", "kind", "ts", "exp", "author", "body", "sig", "nonce", "id")
	dataURL      = regexp.MustCompile(`^data:image/(webp|jpeg|png);base64,`)
	roomName     = regexp.MustCompile(`^[\p{L}\p{N}_-]+$`)
	areaPattern  = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,32}(/[\p{L}\p{N}_-]{1,32}){0,3}$`)
	b64u43       = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	needCats     = set("medicine", "food", "water", "power", "transport", "shelter", "other")
	b64          = base64.RawURLEncoding
)

func set(items ...string) map[string]bool {
	m := map[string]bool{}
	for _, i := range items {
		m[i] = true
	}
	return m
}

// Envelope is a decoded envelope: generic JSON plus the fields the hub indexes.
type Envelope struct {
	Raw    map[string]any
	ID     string
	Kind   string
	Author string
	To     string
	TS     int64
	Exp    int64
	JSON   []byte // canonical serialisation, what the hub stores and sends
}

func parseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

// --- canonical JSON, byte-identical to JavaScript's JSON.stringify with sorted keys ---

func canonical(v any) []byte {
	var b bytes.Buffer
	writeJSON(&b, v)
	return b.Bytes()
}

func writeJSON(b *bytes.Buffer, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		f, _ := x.Float64()
		b.WriteString(jsNumber(f))
	case float64:
		b.WriteString(jsNumber(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case int:
		b.WriteString(strconv.Itoa(x))
	case string:
		quote(b, x)
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, item)
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		// JavaScript compares UTF-16 code units; for keys used by the protocol (ASCII) this
		// equals byte order.
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, k)
			b.WriteByte(':')
			writeJSON(b, x[k])
		}
		b.WriteByte('}')
	default:
		panic(fmt.Sprintf("unsupported JSON value %T", v))
	}
}

func quote(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// jsNumber formats like ECMAScript Number::toString.
func jsNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	neg := f < 0
	e := strconv.FormatFloat(math.Abs(f), 'e', -1, 64) // shortest: d.ddde±XX
	mant, expStr, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	k := len(digits)
	n := exp + 1
	var out string
	switch {
	case n >= k && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case n > 0 && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case n > -6 && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		sign := "+"
		if n-1 < 0 {
			sign = "-"
		}
		m := digits
		if k > 1 {
			m = digits[:1] + "." + digits[1:]
		}
		out = m + "e" + sign + strconv.Itoa(abs(n-1))
	}
	if neg {
		return "-" + out
	}
	return out
}

func abs(i int) int {
	if i < 0 {
		return -i
	}
	return i
}

// --- helpers -------------------------------------------------------------------------

// jsLen is String.prototype.length: UTF-16 code units.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func str(v any, max, min int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	l := jsLen(s)
	return s, l >= min && l <= max
}

func num(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

// safeInt returns v as an integer if it is one within ±2^53.
func safeInt(v any) (int64, bool) {
	f, ok := num(v)
	if !ok || f != math.Trunc(f) || math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

func isDataURL(v any, max int) bool {
	s, ok := str(v, max, 0)
	return ok && dataURL.MatchString(s)
}

func isArea(v any) bool {
	s, ok := str(v, 100, 1)
	return ok && areaPattern.MatchString(s)
}

func isMedia(v any) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	for k := range m {
		if k != "id" && k != "size" && k != "mime" {
			return false
		}
	}
	id, _ := m["id"].(string)
	size, okSize := safeInt(m["size"])
	mime, _ := m["mime"].(string)
	return b64u43.MatchString(id) && okSize && size > 0 && size <= maxMediaBytes && (mime == "image/webp" || mime == "image/jpeg")
}

func isPostTag(v any) bool {
	t, ok := v.(map[string]any)
	if !ok {
		return false
	}
	switch t["type"] {
	case "need", "offer":
		c, _ := t["cat"].(string)
		return len(t) == 2 && needCats[c]
	case "safe":
		return len(t) == 1
	case "missing":
		_, ok := str(t["name"], 60, 1)
		return len(t) == 2 && ok
	}
	return false
}

func validKeys(v any) bool {
	arr, ok := v.([]any)
	if !ok || len(arr) > 3 {
		return false
	}
	for _, k := range arr {
		o, ok := k.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := str(o["k"], 43, 43); !ok {
			return false
		}
		if _, ok := safeInt(o["until"]); !ok {
			return false
		}
	}
	return true
}

func validateBody(kind string, body any, present bool) string {
	if kind == "dm" {
		if present {
			return "dm must not have a body"
		}
		return ""
	}
	b, ok := body.(map[string]any)
	if !ok {
		return "body must be an object"
	}
	has := func(k string) bool { _, ok := b[k]; return ok }
	switch kind {
	case "profile":
		if _, ok := str(b["name"], 40, 1); !ok {
			return "profile.name must be 1-40 chars"
		}
		if has("bio") {
			if _, ok := str(b["bio"], 160, 0); !ok {
				return "profile.bio too long"
			}
		}
		if has("keys") && !validKeys(b["keys"]) {
			return "profile.keys invalid"
		}
	case "post":
		text, ok := str(b["text"], 2000, 0)
		if !ok {
			return "post.text too long"
		}
		if has("image") && !isDataURL(b["image"], 240_000) {
			return "post.image invalid"
		}
		if has("thumb") && !isDataURL(b["thumb"], 12_000) {
			return "post.thumb invalid"
		}
		if has("media") && !isMedia(b["media"]) {
			return "post.media invalid"
		}
		if has("area") && !isArea(b["area"]) {
			return "post.area invalid"
		}
		if has("tag") && !isPostTag(b["tag"]) {
			return "post.tag invalid"
		}
		tag, _ := b["tag"].(map[string]any)
		if text == "" && !has("image") && !has("media") && (tag == nil || tag["type"] != "safe") {
			return "post is empty"
		}
	case "room":
		room, ok := str(b["room"], 32, 1)
		if !ok || !roomName.MatchString(room) {
			return "room name invalid"
		}
		if _, ok := str(b["text"], 2000, 1); !ok {
			return "room.text must be 1-2000 chars"
		}
		if has("area") && !isArea(b["area"]) {
			return "room.area invalid"
		}
	case "alert":
		_, ok1 := str(b["title"], 100, 1)
		_, ok2 := str(b["text"], 1000, 0)
		if !ok1 || !ok2 {
			return "alert text invalid"
		}
		if l, _ := b["level"].(string); l != "info" && l != "warning" && l != "danger" {
			return "alert.level invalid"
		}
	case "sos":
		if _, ok := str(b["text"], 280, 1); !ok {
			return "sos.text must be 1-280 chars"
		}
		if has("area") && !isArea(b["area"]) {
			return "sos.area invalid"
		}
		if has("loc") {
			loc, ok := b["loc"].(map[string]any)
			lat, okLat := num(loc["lat"])
			lon, okLon := num(loc["lon"])
			if !ok || !okLat || !okLon || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
				return "sos.loc invalid"
			}
		}
	default:
		return "unknown kind"
	}
	return ""
}

func leadingZeroBits(h []byte) int {
	n := 0
	for _, b := range h {
		if b == 0 {
			n += 8
			continue
		}
		return n + bits.LeadingZeros8(b)
	}
	return n
}

func priorityOf(e *Envelope) int {
	r := kindRules[e.Kind]
	if e.Kind == "post" {
		if body, ok := e.Raw["body"].(map[string]any); ok {
			if _, ok := body["image"]; ok {
				return r.priority + 1
			}
		}
	}
	return r.priority
}

// Validate checks structure, size, lifetime, signature and proof of work.
func Validate(input any, now int64) (*Envelope, error) {
	env, ok := input.(map[string]any)
	if !ok {
		return nil, errors.New("not an object")
	}
	if v, ok := safeInt(env["v"]); !ok || v != protocolVersion {
		return nil, errors.New("unsupported version")
	}
	kind, _ := env["kind"].(string)
	r, ok := kindRules[kind]
	if !ok {
		return nil, errors.New("unknown kind")
	}
	ts, ok1 := safeInt(env["ts"])
	exp, ok2 := safeInt(env["exp"])
	if !ok1 || !ok2 {
		return nil, errors.New("bad timestamps")
	}
	if ts > now+maxFutureSkew {
		return nil, errors.New("timestamp in the future")
	}
	if exp <= ts || exp-ts > r.maxTTL {
		return nil, errors.New("bad lifetime")
	}
	if exp < now {
		return nil, errors.New("expired")
	}
	nonce, ok := safeInt(env["nonce"])
	if !ok || nonce < 0 || nonce >= 1<<32 {
		return nil, errors.New("bad nonce")
	}
	full := canonical(env)
	if len(full) > r.maxBytes {
		return nil, errors.New("too large")
	}
	allowed := signedFields
	if kind == "dm" {
		allowed = sealedFields
	}
	for k := range env {
		if !allowed[k] {
			return nil, errors.New("unexpected field")
		}
	}

	e := &Envelope{Raw: env, Kind: kind, TS: ts, Exp: exp, JSON: full}
	if kind == "dm" {
		to, ok1 := str(env["to"], 32, 1)
		_, ok2 := str(env["epk"], 64, 1)
		_, ok3 := str(env["ct"], r.maxBytes, 1)
		if !ok1 || !ok2 || !ok3 {
			return nil, errors.New("bad sealed fields")
		}
		e.To = to
	} else {
		author, ok1 := str(env["author"], 64, 1)
		sig, ok2 := str(env["sig"], 128, 1)
		if !ok1 || !ok2 {
			return nil, errors.New("missing author or sig")
		}
		body, present := env["body"]
		if msg := validateBody(kind, body, present); msg != "" {
			return nil, errors.New(msg)
		}
		signed := map[string]any{}
		for _, k := range []string{"v", "kind", "ts", "exp", "author", "body"} {
			if v, ok := env[k]; ok {
				signed[k] = v
			}
		}
		pub, err1 := b64.DecodeString(author)
		sigBytes, err2 := b64.DecodeString(sig)
		if err1 != nil || err2 != nil || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, canonical(signed), sigBytes) {
			return nil, errors.New("bad signature")
		}
		e.Author = author
	}

	rest := map[string]any{}
	for k, v := range env {
		if k != "nonce" && k != "id" {
			rest[k] = v
		}
	}
	base := sha256.Sum256(canonical(rest))
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(nonce))
	h := sha256.Sum256(append(base[:], n[:]...))
	id := b64.EncodeToString(h[:])
	if got, _ := env["id"].(string); got != id {
		return nil, errors.New("id mismatch")
	}
	if leadingZeroBits(h[:]) < r.powBits {
		return nil, errors.New("insufficient proof of work")
	}
	e.ID = id
	return e, nil
}

// areaOf returns the envelope's declared area, if any.
func areaOf(e *Envelope) string {
	if body, ok := e.Raw["body"].(map[string]any); ok {
		a, _ := body["area"].(string)
		return a
	}
	return ""
}

func areasOverlap(a, b string) bool {
	if a == "" || b == "" {
		return true
	}
	x := strings.Split(strings.ToLower(a), "/")
	y := strings.Split(strings.ToLower(b), "/")
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// --- summaries (packages/protocol/src/summary.ts) ----------------------------------------

type idTS struct {
	id string
	ts int64
}

func summarize(items []idTS) [][3]any {
	type bucket struct {
		n int
		x [8]byte
	}
	days := map[int64]*bucket{}
	for _, it := range items {
		d := it.ts / day
		if it.ts < 0 && it.ts%day != 0 {
			d--
		}
		b := days[d]
		if b == nil {
			b = &bucket{}
			days[d] = b
		}
		b.n++
		raw, _ := b64.DecodeString(it.id)
		for i := 0; i < 8 && i < len(raw); i++ {
			b.x[i] ^= raw[i]
		}
	}
	keys := make([]int64, 0, len(days))
	for d := range days {
		keys = append(keys, d)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([][3]any, 0, len(keys))
	for _, d := range keys {
		b := days[d]
		out = append(out, [3]any{d, b.n, fmt.Sprintf("%x", b.x[:])})
	}
	return out
}

var _ = utf8.RuneError
