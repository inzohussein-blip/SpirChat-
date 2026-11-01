// Command spirchat-hub is a lightweight SpirChat hub for small routers (OpenWrt) and
// single-board computers: one static binary, no Node.js, no database. It speaks the same
// protocol and reads the same environment variables as the Node hub in ../hub.
//
//	GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="-s -w" -o spirchat-hub .
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Port       int
	Host       string
	Name       string
	DataDir    string
	WebDir     string
	Peers      []string
	PeerEvery  time.Duration
	AlertKeys  []string
	MaxStore   int
	Captive    bool
	TrustProxy bool
	Area       string
	DenyKeys   []string
	Quotas     map[string]int
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func list(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, strings.TrimRight(s, "/"))
		}
	}
	return out
}

func atoi(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func loadConfig() Config {
	exe, _ := os.Executable()
	here := filepath.Dir(exe)
	return Config{
		Port:       atoi(env("PORT", "80"), 80),
		Host:       env("HOST", "0.0.0.0"),
		Name:       env("HUB_NAME", "SpirChat"),
		DataDir:    env("DATA_DIR", filepath.Join(here, "data")),
		WebDir:     env("WEB_DIR", filepath.Join(here, "web")),
		Peers:      list(env("PEERS", "")),
		PeerEvery:  time.Duration(atoi(env("PEER_INTERVAL_SEC", "30"), 30)) * time.Second,
		AlertKeys:  list(env("ALERT_KEYS", "")),
		MaxStore:   atoi(env("MAX_STORE_MB", "256"), 256) * 1024 * 1024,
		Captive:    env("CAPTIVE", "") == "1",
		TrustProxy: env("TRUST_PROXY", "") == "1",
		Area:       strings.ToLower(strings.TrimSpace(env("HUB_AREA", ""))),
		DenyKeys:   list(env("DENY_KEYS", "")),
		Quotas: map[string]int{
			"post":    atoi(env("QUOTA_POST", "30"), 30),
			"room":    atoi(env("QUOTA_ROOM", "300"), 300),
			"profile": atoi(env("QUOTA_PROFILE", "10"), 10),
			"sos":     atoi(env("QUOTA_SOS", "5"), 5),
		},
	}
}

// pullFromPeer copies new envelopes (and the images they reference) from another hub.
func pullFromPeer(h *Hub, url string) (int, error) {
	c := h.store.PeerCursor(url)
	added := 0
	client := &http.Client{Timeout: 30 * time.Second}
	for {
		res, err := client.Get(fmt.Sprintf("%s/api/sync?since=%d&limit=500", url, c.Cursor))
		if err != nil {
			return added, err
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
		res.Body.Close()
		if err != nil || res.StatusCode != 200 {
			return added, fmt.Errorf("%s: HTTP %d", url, res.StatusCode)
		}
		var p struct {
			HubID string `json:"hubId"`
			Items []struct {
				Env json.RawMessage `json:"env"`
			} `json:"items"`
			Last int64 `json:"last"`
			More bool  `json:"more"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return added, err
		}
		if p.HubID == h.store.HubID {
			return added, fmt.Errorf("%s: is this hub", url)
		}
		if p.HubID != c.HubID && (c.HubID != "" || c.Cursor != 0) {
			c = peerCursor{HubID: p.HubID} // peer reinstalled: start over
			continue
		}
		c.HubID = p.HubID
		for _, it := range p.Items {
			raw, err := parseJSON(it.Env)
			if err != nil {
				continue
			}
			if seq, err := h.Accept(raw); err == nil && seq != 0 {
				added++
				if m := mediaID(raw); m != "" && len(h.store.MissingBlobs([]string{m})) == 1 {
					fetchBlob(h, client, url, m)
				}
			}
		}
		c.Cursor = p.Last
		h.store.SetPeerCursor(url, c)
		if !p.More {
			return added, nil
		}
	}
}

func mediaID(raw any) string {
	env, _ := raw.(map[string]any)
	if env["kind"] != "post" {
		return ""
	}
	body, _ := env["body"].(map[string]any)
	media, _ := body["media"].(map[string]any)
	id, _ := media["id"].(string)
	return id
}

func fetchBlob(h *Hub, client *http.Client, url, id string) {
	res, err := client.Get(url + "/api/blobs/" + id)
	if err != nil {
		return
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxMediaBytes+1))
	mime := res.Header.Get("content-type")
	sum := sha256.Sum256(data)
	if err == nil && res.StatusCode == 200 && (mime == "image/webp" || mime == "image/jpeg") && b64.EncodeToString(sum[:]) == id {
		_ = h.store.PutBlob(id, mime, data)
	}
}

func main() {
	cfg := loadConfig()
	store, err := OpenStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("data dir %s: %v", cfg.DataDir, err)
	}
	hub := NewHub(cfg, store)

	maintain := func() {
		if hub.denyChanged() {
			hub.reloadDeny()
			log.Println("deny list reloaded")
		}
		hub.mu.Lock()
		denied := hub.deny
		hub.mu.Unlock()
		if n, err := store.Prune(cfg.MaxStore*3/4, denied); err != nil {
			log.Println("prune:", err)
		} else if n > 0 {
			log.Printf("pruned %d envelopes", n)
		}
		store.PruneBlobs(60*24*time.Hour, int64(cfg.MaxStore/4))
	}
	maintain()
	go func() {
		for range time.Tick(time.Minute) {
			maintain()
		}
	}()
	if len(cfg.Peers) > 0 {
		go func() {
			for {
				for _, p := range cfg.Peers {
					if n, err := pullFromPeer(hub, p); err != nil {
						log.Printf("peer %s: %v", p, err)
					} else if n > 0 {
						log.Printf("peer %s: +%d envelopes", p, n)
					}
				}
				time.Sleep(cfg.PeerEvery)
			}
		}()
	}

	srv := &http.Server{Addr: fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), Handler: hub.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	log.Printf("SpirChat hub %q (%s) on http://%s  data: %s  web: %s", cfg.Name, store.HubID, srv.Addr, cfg.DataDir, cfg.WebDir)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
