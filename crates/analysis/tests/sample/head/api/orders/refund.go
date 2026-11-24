package orders

import (
	"net/http"
	"os"

	"example.com/shop/lib/db"
)

// HandleRefund refunds one order's payment through Stripe and records it.
func HandleRefund(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("order")
	req, _ := http.NewRequest("POST", "https://api.stripe.com/v1/refunds?payment_intent="+id, nil)
	req.SetBasicAuth(os.Getenv("STRIPE_KEY"), "")
	if _, err := http.DefaultClient.Do(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	db.Exec("UPDATE orders SET refunded = true WHERE id = $1", id)
	w.WriteHeader(http.StatusNoContent)
}
