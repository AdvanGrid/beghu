package main

import (
	"net/http"

	"example.com/shop/api/health"
	"example.com/shop/api/orders"
)

func main() {
	http.HandleFunc("/health", health.Handle)
	http.HandleFunc("/orders", orders.HandleList)
	http.ListenAndServe(":8080", nil)
}
