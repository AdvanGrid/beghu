-- Filter-bar fragments. Each one is a predicate over `items i`, checked as
-- `SELECT 1 FROM items i WHERE (<fragment>)`, and composed at run time with AND/OR/NOT.

-- name: label :fragment
-- param: name &str
i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = :name)

-- name: assignee :fragment
-- param: login &str
i.id IN (SELECT ia.item_id FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE u.login = :login)

-- name: repo :fragment
-- param: name &str
i.repo_id IN (SELECT r.id FROM repos r WHERE r.name = :name)

-- name: state :fragment
-- param: state &str
i.state = :state

-- name: no_milestone :fragment
i.milestone_id IS NULL

-- name: text :fragment
-- param: q &str
i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q)
