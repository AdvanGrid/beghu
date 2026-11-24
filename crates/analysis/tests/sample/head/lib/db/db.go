package db

import (
	"database/sql"
	"os"

	_ "github.com/lib/pq"
)

var conn, _ = sql.Open("postgres", os.Getenv("DATABASE_URL"))

// Query runs a read against Postgres.
func Query(q string, args ...any) (*sql.Rows, error) {
	return conn.Query(q, args...)
}

// Exec runs a write against Postgres.
func Exec(q string, args ...any) error {
	_, err := conn.Exec(q, args...)
	return err
}
