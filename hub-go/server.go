package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Hub: validation, policy (alerts, area, deny list, quotas) and live subscribers.
type Hub struct {
	cfg   Config
	store *Store
	mu    sync.Mutex
	subs  map[int]func(int64, *Envelope)
	next  int
	deny  map[string]bool
	denyT time.Time
}

func NewHub(cfg Config, store *Store) *Hub {
	h := &Hub{cfg: cfg, store: store, subs: map[int]func(int64, *Envelope){}}
	h.reloadDeny()
	return h
}

func (h *Hub) denyFile() string { return filepath.Join(h.cfg.DataDir, "deny.txt") }

// reloadDeny reads DENY_KEYS and DATA_DIR/deny.txt (one ID per line, '#' comments).
func (h *Hub) reloadDeny() {
	keys := map[string]bool{}
	for _, k := range h.cfg.DenyKeys {
		keys[k] = true
	}
	if info, err := os.Stat(h.denyFile()); err == nil {
		h.denyT = info.ModTime()
		if b, err := os.ReadFile(h.denyFile()); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if k := strings.TrimSpace(strings.SplitN(line, "#", 2)[0]); k != "" {
					keys[k] = true
				}
			}
		}
	}
	h.mu.Lock()
	h.deny = keys
	h.mu.Unlock()
}

func (h *Hub) denyChanged() bool {
	info, err := os.Stat(h.denyFile())
	if err != nil {
		return !h.denyT.IsZero()
	}
	return !info.ModTime().Equal(h.denyT)
}

func (h *Hub) denied(author string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.deny[author]
}

// Accept validates and stores; seq is 0 for a duplicate.
func (h *Hub) Accept(raw any) (int64, error) {
	e, err := Validate(raw, time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	if e.Kind == "alert" && !contains(h.cfg.AlertKeys, e.Author) {
		return 0, fmt.Errorf("author not allowed to publish alerts")
	}
	if e.Author != "" && h.denied(e.Author) {
		return 0, fmt.Errorf("author blocked on this hub")
	}
	if !areasOverlap(h.cfg.Area, areaOf(e)) {
		return 0, fmt.Errorf("outside this hub area")
	}
	if q, ok := h.cfg.Quotas[e.Kind]; ok && e.Author != "" && len(h.store.Missing([]string{e.ID})) == 1 {
		d := (e.TS / day) * day
		if h.store.CountByAuthor(e.Author, e.Kind, d, d+day) >= q {
			return 0, fmt.Errorf("daily quota reached")
		}
	}
	seq, err := h.store.Insert(e)
	if err != nil || seq == 0 {
		return 0, err
	}
	h.mu.Lock()
	subs := make([]func(int64, *Envelope), 0, len(h.subs))
	for _, s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.Unlock()
	for _, s := range subs {
		s(seq, e)
	}
	return seq, nil
}

func (h *Hub) Subscribe(f func(int64, *Envelope)) func() {
	h.mu.Lock()
	id := h.next
	h.next++
	h.subs[id] = f
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		delete(h.subs, id)
		h.mu.Unlock()
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// --- rate limiting ---------------------------------------------------------------------

type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	m      map[string]*struct {
		start time.Time
		n     int
	}
}

func newLimiter(limit int, window time.Duration) *limiter {
	return &limiter{limit: limit, window: window, m: map[string]*struct {
		start time.Time
		n     int
	}{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w := l.m[key]
	if w == nil || now.Sub(w.start) >= l.window {
		if len(l.m) > 10000 {
			l.m = map[string]*struct {
				start time.Time
				n     int
			}{}
		}
		w = &struct {
			start time.Time
			n     int
		}{now, 0}
		l.m[key] = w
	}
	w.n++
	return w.n <= l.limit
}

// --- HTTP -------------------------------------------------------------------------------

var captiveProbes = map[string]bool{
	"/generate_204": true, "/gen_204": true, "/hotspot-detect.html": true, "/library/test/success.html": true,
	"/connecttest.txt": true, "/ncsi.txt": true, "/success.txt": true, "/canonical.html": true, "/redirect": true,
}

var (
	blobPath = regexp.MustCompile(`^/api/blobs/([A-Za-z0-9_-]{43})$`)
	ipHost   = regexp.MustCompile(`^[\d.]+$`)
	mimeOf   = map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
		".png": "image/png", ".ico": "image/x-icon", ".apk": "application/vnd.android.package-archive",
	}
)

func writeJSONResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("access-control-allow-origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Hub) clientIP(r *http.Request) string {
	if h.cfg.TrustProxy {
		if f := strings.TrimSpace(strings.Split(r.Header.Get("x-forwarded-for"), ",")[0]); f != "" {
			return f
		}
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func (h *Hub) Handler() http.Handler {
	importLimit := newLimiter(20, time.Minute)
	blobLimit := newLimiter(60, time.Minute)
	mux := http.NewServeMux()

	mux.HandleFunc("/ws", h.serveWS)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if h.cfg.Captive {
			host := strings.Split(r.Host, ":")[0]
			foreign := host != "" && host != "spirchat.local" && host != "localhost" && !ipHost.MatchString(host)
			if captiveProbes[path] || foreign {
				http.Redirect(w, r, "http://spirchat.local/", http.StatusFound)
				return
			}
		}
		if r.Method == http.MethodOptions && strings.HasPrefix(path, "/api/") {
			w.Header().Set("access-control-allow-origin", "*")
			w.Header().Set("access-control-allow-methods", "GET, POST, PUT")
			w.Header().Set("access-control-allow-headers", "content-type")
			w.Header().Set("access-control-max-age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if m := blobPath.FindStringSubmatch(path); m != nil {
			h.serveBlob(w, r, m[1], blobLimit)
			return
		}
		switch {
		case path == "/api/blobs/missing" && r.Method == http.MethodPost:
			var req struct{ IDs []string }
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
				writeJSONResponse(w, 400, map[string]string{"error": "bad request"})
				return
			}
			if len(req.IDs) > 1000 {
				req.IDs = req.IDs[:1000]
			}
			writeJSONResponse(w, 200, map[string]any{"missing": h.store.MissingBlobs(req.IDs)})
		case path == "/api/info" && r.Method == http.MethodGet:
			count, bytes, byKind := h.store.Stats()
			writeJSONResponse(w, 200, map[string]any{
				"hubId": h.store.HubID, "name": h.cfg.Name, "seq": h.store.MaxSeq(), "count": count, "bytes": bytes, "byKind": byKind,
			})
		case path == "/api/sync" && r.Method == http.MethodGet:
			since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			if limit < 1 || limit > 1000 {
				limit = 200
			}
			items := h.store.Since(since, limit+1, 0, 99)
			more := len(items) > limit
			if more {
				items = items[:limit]
			}
			last := since
			out := make([]map[string]any, 0, len(items))
			for _, it := range items {
				out = append(out, map[string]any{"seq": it.Seq, "env": json.RawMessage(it.Env.JSON)})
				last = it.Seq
			}
			writeJSONResponse(w, 200, map[string]any{"hubId": h.store.HubID, "items": out, "last": last, "more": more})
		case path == "/api/envelopes" && r.Method == http.MethodPost:
			if !importLimit.allow(h.clientIP(r)) {
				writeJSONResponse(w, 429, map[string]string{"error": "slow down"})
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
			if err != nil {
				writeJSONResponse(w, 400, map[string]string{"error": err.Error()})
				return
			}
			envs, err := parseEnvelopes(body)
			if err != nil {
				writeJSONResponse(w, 400, map[string]string{"error": err.Error()})
				return
			}
			added, rejected := 0, 0
			for _, e := range envs {
				seq, err := h.Accept(e)
				if err != nil {
					rejected++
				} else if seq != 0 {
					added++
				}
			}
			writeJSONResponse(w, 200, map[string]int{"received": len(envs), "added": added, "rejected": rejected})
		case path == "/api/export" && r.Method == http.MethodGet:
			w.Header().Set("content-type", "application/x-ndjson")
			w.Header().Set("content-disposition", fmt.Sprintf(`attachment; filename="spirchat-%s-%d.ndjson"`, h.store.HubID[:8], time.Now().UnixMilli()))
			var since int64
			for {
				page := h.store.Since(since, 500, 0, 99)
				if len(page) == 0 {
					break
				}
				for _, it := range page {
					_, _ = w.Write(it.Env.JSON)
					_, _ = w.Write([]byte("\n"))
				}
				since = page[len(page)-1].Seq
			}
		case path == "/spirchat.apk" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
			apk := filepath.Join(h.cfg.DataDir, "spirchat.apk")
			if _, err := os.Stat(apk); err != nil {
				writeJSONResponse(w, 404, map[string]string{"error": "no apk on this hub"})
				return
			}
			w.Header().Set("content-type", mimeOf[".apk"])
			w.Header().Set("content-disposition", `attachment; filename="SpirChat.apk"`)
			http.ServeFile(w, r, apk)
		case strings.HasPrefix(path, "/api/"):
			writeJSONResponse(w, 404, map[string]string{"error": "not found"})
		case r.Method != http.MethodGet && r.Method != http.MethodHead:
			writeJSONResponse(w, 405, map[string]string{"error": "method not allowed"})
		default:
			h.serveStatic(w, r)
		}
	})
	return mux
}

func parseEnvelopes(body []byte) ([]any, error) {
	t := strings.TrimSpace(string(body))
	if strings.HasPrefix(t, "[") {
		v, err := parseJSON([]byte(t))
		if err != nil {
			return nil, err
		}
		arr, _ := v.([]any)
		return arr, nil
	}
	var out []any
	sc := bufio.NewScanner(strings.NewReader(t))
	sc.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		v, err := parseJSON([]byte(line))
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, sc.Err()
}

func (h *Hub) serveBlob(w http.ResponseWriter, r *http.Request, id string, lim *limiter) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		mime, data, ok := h.store.GetBlob(id)
		if !ok {
			writeJSONResponse(w, 404, map[string]string{"error": "not found"})
			return
		}
		w.Header().Set("content-type", mime)
		w.Header().Set("content-length", strconv.Itoa(len(data)))
		w.Header().Set("cache-control", "public, max-age=31536000, immutable")
		w.Header().Set("access-control-allow-origin", "*")
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
	case http.MethodPut:
		if !lim.allow(h.clientIP(r)) {
			writeJSONResponse(w, 429, map[string]string{"error": "slow down"})
			return
		}
		mime := strings.TrimSpace(strings.Split(r.Header.Get("content-type"), ";")[0])
		if mime != "image/webp" && mime != "image/jpeg" {
			writeJSONResponse(w, 415, map[string]string{"error": "unsupported media type"})
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, maxMediaBytes+1))
		if err != nil || len(data) > maxMediaBytes {
			writeJSONResponse(w, 413, map[string]string{"error": "too large"})
			return
		}
		sum := sha256.Sum256(data)
		if b64.EncodeToString(sum[:]) != id {
			writeJSONResponse(w, 400, map[string]string{"error": "hash mismatch"})
			return
		}
		if err := h.store.PutBlob(id, mime, data); err != nil {
			writeJSONResponse(w, 500, map[string]string{"error": "internal error"})
			return
		}
		writeJSONResponse(w, 200, map[string]bool{"ok": true})
	default:
		writeJSONResponse(w, 405, map[string]string{"error": "method not allowed"})
	}
}

func (h *Hub) serveStatic(w http.ResponseWriter, r *http.Request) {
	root := h.cfg.WebDir
	file := filepath.Join(root, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
	if !strings.HasPrefix(file, root) {
		writeJSONResponse(w, 400, map[string]string{"error": "bad path"})
		return
	}
	if info, err := os.Stat(file); err != nil || info.IsDir() {
		file = filepath.Join(root, "index.html")
	}
	if _, err := os.Stat(file); err != nil {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("SpirChat hub is running, but the web app is not installed (WEB_DIR).\n"))
		return
	}
	if ct, ok := mimeOf[filepath.Ext(file)]; ok {
		w.Header().Set("content-type", ct)
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("cache-control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("cache-control", "no-cache")
	}
	http.ServeFile(w, r, file)
}

// --- WebSocket: the client protocol in packages/protocol/src/wire.ts ----------------------

const page = 200

func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(512 * 1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.CloseNow()

	out := make(chan []byte, 4096)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-out:
				wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
				err := conn.Write(wctx, websocket.MessageText, m)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	send := func(v any) {
		b, _ := json.Marshal(v)
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}
	envMsg := func(seq int64, e *Envelope) []byte {
		return append(append([]byte(`{"t":"env","seq":`+strconv.FormatInt(seq, 10)+`,"env":`), e.JSON...), '}')
	}
	sendRaw := func(b []byte) {
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}

	fresh := newLimiter(60, time.Minute)
	author := newLimiter(30, time.Minute)
	carry := newLimiter(5000, time.Minute)
	var unsubscribe func()
	defer func() {
		if unsubscribe != nil {
			unsubscribe()
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		v, err := parseJSON(data)
		msg, ok := v.(map[string]any)
		if err != nil || !ok {
			_ = conn.Close(websocket.StatusUnsupportedData, "bad json")
			return
		}
		switch msg["t"] {
		case "hello":
			if unsubscribe != nil {
				continue
			}
			alertKeys := h.cfg.AlertKeys
			if alertKeys == nil {
				alertKeys = []string{}
			}
			send(map[string]any{"t": "welcome", "hubId": h.store.HubID, "name": h.cfg.Name, "seq": h.store.MaxSeq(), "alertKeys": alertKeys})
			unsubscribe = h.Subscribe(func(seq int64, e *Envelope) {
				select {
				case out <- envMsg(seq, e):
				default: // too slow: it will catch up from its cursor next time
					cancel()
				}
			})
			var since int64
			if id, _ := msg["hubId"].(string); id == h.store.HubID {
				since, _ = safeInt(msg["since"])
			}
			go func() {
				upTo := h.store.MaxSeq()
				// Text and alerts first, so they arrive even if the link drops during images.
				for _, pr := range [][2]int{{0, 2}, {3, 99}} {
					cursor := since
					for ctx.Err() == nil {
						items := h.store.Since(cursor, page, pr[0], pr[1])
						n := 0
						for _, it := range items {
							if it.Seq > upTo {
								break
							}
							sendRaw(envMsg(it.Seq, it.Env))
							cursor = it.Seq
							n++
						}
						if n < page {
							break
						}
					}
				}
				send(map[string]any{"t": "synced", "seq": upTo})
			}()
		case "sum":
			items := h.store.LiveIDs()
			send(map[string]any{"t": "sum", "buckets": summarize(items)})
		case "have":
			raw, _ := msg["ids"].([]any)
			ids := make([]string, 0, len(raw))
			for _, x := range raw {
				if s, ok := x.(string); ok && len(ids) < maxHaveIDs {
					ids = append(ids, s)
				}
			}
			send(map[string]any{"t": "want", "ids": h.store.Missing(ids)})
		case "publish":
			env, _ := msg["env"].(map[string]any)
			id, _ := env["id"].(string)
			ts, _ := safeInt(env["ts"])
			isFresh := time.Now().UnixMilli()-ts < 10*60_000
			a, _ := env["author"].(string)
			allowed := carry.allow("c")
			if isFresh {
				allowed = fresh.allow("c") && (a == "" || author.allow(a))
			}
			if !allowed {
				send(map[string]any{"t": "ack", "id": id, "ok": false, "error": "rate limited"})
				continue
			}
			if _, err := h.Accept(env); err != nil {
				send(map[string]any{"t": "ack", "id": id, "ok": false, "error": err.Error()})
			} else {
				send(map[string]any{"t": "ack", "id": id, "ok": true})
			}
		}
	}
}

var _ = log.Println
