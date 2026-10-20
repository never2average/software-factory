package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	store := NewStore()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /notes", store.handleList)
	mux.HandleFunc("POST /notes", store.handleCreate)

	addr := ":" + envOr("PORT", "8080")
	log.Printf("notes listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
