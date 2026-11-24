package orders

import (
	"encoding/json"
	"net/http"

	"example.com/shop/lib/db"
)

// HandleList writes every order as JSON.
func HandleList(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query("SELECT id, total FROM orders")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(rows)
}
