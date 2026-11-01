package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Store keeps envelopes in memory with an append-only log on disk (no database, so the hub
// runs on small routers). Each log line is {"seq":n,"env":{...}}; sequence numbers survive
// restarts and compaction because clients use them as sync cursors.
type Store struct {
	mu      sync.RWMutex
	dir     string
	log     *os.File
	byID    map[string]*stored
	bySeq   []*stored // ascending seq
	nextSeq int64
	bytes   int
	HubID   string
	peers   map[string]peerCursor
}

type stored struct {
	seq  int64
	env  *Envelope
	prio int
}

type peerCursor struct {
	HubID  string `json:"hubId"`
	Cursor int64  `json:"cursor"`
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "blobs"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, byID: map[string]*stored{}, nextSeq: 1, peers: map[string]peerCursor{}}
	idFile := filepath.Join(dir, "hub_id")
	if b, err := os.ReadFile(idFile); err == nil {
		s.HubID = strings.TrimSpace(string(b))
	} else {
		var r [16]byte
		_, _ = rand.Read(r[:])
		h := hex.EncodeToString(r[:])
		s.HubID = h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
		if err := os.WriteFile(idFile, []byte(s.HubID), 0o644); err != nil {
			return nil, err
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "peers.json")); err == nil {
		_ = json.Unmarshal(b, &s.peers)
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(s.logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	s.log = f
	return s, nil
}

func (s *Store) logPath() string { return filepath.Join(s.dir, "envelopes.ndjson") }

func (s *Store) load() error {
	f, err := os.Open(s.logPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	now := time.Now().UnixMilli()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for sc.Scan() {
		var line struct {
			Seq int64           `json:"seq"`
			Env json.RawMessage `json:"env"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue // a torn last line after a power cut
		}
		raw, err := parseJSON(line.Env)
		if err != nil {
			continue
		}
		// Re-validate with a lenient clock: entries were valid when written.
		e, err := Validate(raw, now)
		if err != nil {
			continue
		}
		if line.Seq >= s.nextSeq {
			s.nextSeq = line.Seq + 1
		}
		s.add(&stored{seq: line.Seq, env: e, prio: priorityOf(e)})
	}
	sort.Slice(s.bySeq, func(i, j int) bool { return s.bySeq[i].seq < s.bySeq[j].seq })
	return sc.Err()
}

func (s *Store) add(st *stored) {
	if _, dup := s.byID[st.env.ID]; dup {
		return
	}
	s.byID[st.env.ID] = st
	s.bySeq = append(s.bySeq, st)
	s.bytes += len(st.env.JSON)
}

// Insert returns the new sequence number, or 0 if the envelope was already stored.
func (s *Store) Insert(e *Envelope) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.byID[e.ID]; dup {
		return 0, nil
	}
	seq := s.nextSeq
	line := append([]byte(`{"seq":`+strconv.FormatInt(seq, 10)+`,"env":`), e.JSON...)
	line = append(line, "}\n"...)
	if _, err := s.log.Write(line); err != nil {
		return 0, err
	}
	s.nextSeq++
	s.add(&stored{seq: seq, env: e, prio: priorityOf(e)})
	return seq, nil
}

func (s *Store) Missing(ids []string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []string{}
	for _, id := range ids {
		if _, ok := s.byID[id]; !ok {
			out = append(out, id)
		}
	}
	return out
}

type seqEnv struct {
	Seq int64
	Env *Envelope
}

// Since returns live envelopes after seq within the priority range, in sequence order.
func (s *Store) Since(seq int64, limit, prioMin, prioMax int) []seqEnv {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UnixMilli()
	i := sort.Search(len(s.bySeq), func(i int) bool { return s.bySeq[i].seq > seq })
	out := []seqEnv{}
	for ; i < len(s.bySeq) && len(out) < limit; i++ {
		st := s.bySeq[i]
		if st.prio < prioMin || st.prio > prioMax || st.env.Exp <= now {
			continue
		}
		out = append(out, seqEnv{st.seq, st.env})
	}
	return out
}

func (s *Store) MaxSeq() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nextSeq - 1
}

func (s *Store) Stats() (count, bytes int, byKind map[string]int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	byKind = map[string]int{}
	for _, st := range s.bySeq {
		byKind[st.env.Kind]++
	}
	return len(s.bySeq), s.bytes, byKind
}

func (s *Store) LiveIDs() []idTS {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UnixMilli()
	out := make([]idTS, 0, len(s.bySeq))
	for _, st := range s.bySeq {
		if st.env.Exp > now {
			out = append(out, idTS{st.env.ID, st.env.TS})
		}
	}
	return out
}

func (s *Store) CountByAuthor(author, kind string, from, to int64) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, st := range s.bySeq {
		if st.env.Author == author && st.env.Kind == kind && st.env.TS >= from && st.env.TS < to {
			n++
		}
	}
	return n
}

// Prune drops expired envelopes and denied authors, then the least urgent until under
// maxBytes, and compacts the log.
func (s *Store) Prune(maxBytes int, denied map[string]bool) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	keep := make([]*stored, 0, len(s.bySeq))
	bytes := 0
	for _, st := range s.bySeq {
		if st.env.Exp > now && !denied[st.env.Author] {
			keep = append(keep, st)
			bytes += len(st.env.JSON)
		}
	}
	if bytes > maxBytes {
		order := append([]*stored(nil), keep...)
		sort.SliceStable(order, func(i, j int) bool {
			if order[i].prio != order[j].prio {
				return order[i].prio > order[j].prio
			}
			return order[i].seq < order[j].seq
		})
		drop := map[string]bool{}
		for _, st := range order {
			if bytes <= maxBytes {
				break
			}
			drop[st.env.ID] = true
			bytes -= len(st.env.JSON)
		}
		filtered := keep[:0]
		for _, st := range keep {
			if !drop[st.env.ID] {
				filtered = append(filtered, st)
			}
		}
		keep = filtered
	}
	removed := len(s.bySeq) - len(keep)
	if removed == 0 {
		return 0, nil
	}
	tmp := s.logPath() + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	w := bufio.NewWriter(f)
	for _, st := range keep {
		_, _ = w.WriteString(`{"seq":` + strconv.FormatInt(st.seq, 10) + `,"env":`)
		_, _ = w.Write(st.env.JSON)
		_, _ = w.WriteString("}\n")
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return 0, err
	}
	f.Close()
	s.log.Close()
	if err := os.Rename(tmp, s.logPath()); err != nil {
		return 0, err
	}
	if s.log, err = os.OpenFile(s.logPath(), os.O_APPEND|os.O_WRONLY, 0o644); err != nil {
		return 0, err
	}
	s.byID = map[string]*stored{}
	s.bySeq = nil
	s.bytes = 0
	for _, st := range keep {
		s.add(st)
	}
	return removed, nil
}

func (s *Store) PeerCursor(url string) peerCursor {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.peers[url]
}

func (s *Store) SetPeerCursor(url string, c peerCursor) {
	s.mu.Lock()
	s.peers[url] = c
	b, _ := json.Marshal(s.peers)
	s.mu.Unlock()
	_ = os.WriteFile(filepath.Join(s.dir, "peers.json"), b, 0o644)
}

// --- images: one file per hash under DATA_DIR/blobs ------------------------------------

func mimeExt(mime string) string {
	if mime == "image/webp" {
		return ".webp"
	}
	return ".jpg"
}

func (s *Store) blobPath(id, mime string) string {
	return filepath.Join(s.dir, "blobs", id+mimeExt(mime))
}

func (s *Store) PutBlob(id, mime string, data []byte) error {
	p := s.blobPath(id, mime)
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) GetBlob(id string) (string, []byte, bool) {
	for _, mime := range []string{"image/webp", "image/jpeg"} {
		if b, err := os.ReadFile(s.blobPath(id, mime)); err == nil {
			return mime, b, true
		}
	}
	return "", nil, false
}

func (s *Store) MissingBlobs(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if _, _, ok := s.GetBlob(id); !ok {
			out = append(out, id)
		}
	}
	return out
}

// PruneBlobs removes images older than maxAge, oldest first beyond maxBytes.
func (s *Store) PruneBlobs(maxAge time.Duration, maxBytes int64) {
	entries, err := os.ReadDir(filepath.Join(s.dir, "blobs"))
	if err != nil {
		return
	}
	type f struct {
		path string
		mod  time.Time
		size int64
	}
	var files []f
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(s.dir, "blobs", e.Name())
		if time.Since(info.ModTime()) > maxAge {
			_ = os.Remove(p)
			continue
		}
		files = append(files, f{p, info.ModTime(), info.Size()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, x := range files {
		if total <= maxBytes {
			break
		}
		_ = os.Remove(x.path)
		total -= x.size
	}
}
