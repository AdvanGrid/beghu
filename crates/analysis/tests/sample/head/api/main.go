package main

import (
	"net/http"

	"example.com/shop/api/health"
	"example.com/shop/api/orders"
)

func main() {
	http.HandleFunc("/health", health.Handle)
	http.HandleFunc("/orders", orders.HandleList)
	http.HandleFunc("/orders/refund", orders.HandleRefund)
	http.ListenAndServe(":8080", nil)
}
