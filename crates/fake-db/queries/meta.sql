-- name: fixture :opt
SELECT m.fixture FROM fake_meta m WHERE m.id = 1;

-- name: set_fixture :exec
-- param: fixture &str
INSERT INTO fake_meta (id, fixture) VALUES (1, :fixture)
ON CONFLICT (id) DO UPDATE SET fixture = excluded.fixture;
