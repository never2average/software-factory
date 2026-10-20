package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type Note struct {
	ID        int       `json:"id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

type Store struct {
	mu    sync.Mutex
	notes []Note
}

func NewStore() *Store { return &Store{} }

func (s *Store) handleList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.notes)
}

func (s *Store) handleCreate(w http.ResponseWriter, r *http.Request) {
	var n Note
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	s.mu.Lock()
	n.ID = len(s.notes) + 1
	n.CreatedAt = time.Now().UTC()
	s.notes = append(s.notes, n)
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, n)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
