package health

import "net/http"

// Handle answers the load balancer's health probe.
func Handle(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
