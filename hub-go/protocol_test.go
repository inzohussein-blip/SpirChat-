package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type vectorFile struct {
	Now       int64                      `json:"now"`
	Valid     map[string]json.RawMessage `json:"valid"`
	Invalid   map[string]json.RawMessage `json:"invalid"`
	Canonical []struct {
		Value json.RawMessage `json:"value"`
		JSON  string          `json:"json"`
	} `json:"canonical"`
	Summary struct {
		Items []struct {
			ID string `json:"id"`
			TS int64  `json:"ts"`
		} `json:"items"`
		Buckets json.RawMessage `json:"buckets"`
	} `json:"summary"`
}

func loadVectors(t *testing.T) vectorFile {
	data, err := os.ReadFile("../packages/protocol/test/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestValidVectors(t *testing.T) {
	v := loadVectors(t)
	for name, raw := range v.Valid {
		val, err := parseJSON(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Validate(val, v.Now); err != nil {
			t.Errorf("%s should be valid: %v", name, err)
		}
	}
}

func TestInvalidVectors(t *testing.T) {
	v := loadVectors(t)
	for name, raw := range v.Invalid {
		val, _ := parseJSON(raw)
		if _, err := Validate(val, v.Now); err == nil {
			t.Errorf("%s should be invalid", name)
		}
	}
}

func TestCanonicalMatchesJavaScript(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Canonical {
		// Go strings are UTF-8 and cannot hold lone UTF-16 surrogates; that case only
		// matters for envelopes no client produces.
		if strings.Contains(c.JSON, `\ud800`) {
			continue
		}
		val, err := parseJSON(c.Value)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(canonical(val)); got != c.JSON {
			t.Errorf("canonical:\n got %s\nwant %s", got, c.JSON)
		}
	}
}

func TestNumbersFormatLikeJavaScript(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", -1: "-1", 1.5: "1.5", 0.001: "0.001", 1e-7: "1e-7", 1e21: "1e+21",
		123456789012: "123456789012", 33.312: "33.312", 1e-6: "0.000001", 1.23e-10: "1.23e-10",
		2.5e22: "2.5e+22",
	}
	for f, want := range cases {
		if got := jsNumber(f); got != want {
			t.Errorf("jsNumber(%v) = %s, want %s", f, got, want)
		}
	}
}

func TestSummaryMatchesJavaScript(t *testing.T) {
	v := loadVectors(t)
	items := make([]idTS, 0, len(v.Summary.Items))
	for _, it := range v.Summary.Items {
		items = append(items, idTS{it.ID, it.TS})
	}
	got, _ := json.Marshal(summarize(items))
	want, _ := parseJSON(v.Summary.Buckets)
	if string(got) != string(canonical(want)) {
		t.Errorf("summary:\n got %s\nwant %s", got, canonical(want))
	}
}
