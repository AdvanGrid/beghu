use rusqlite::ToSql;
use rusqlite::types::{ToSqlOutput, Value};

/// A filter-bar query: checked fragments (generated in `frag`) joined at run time. Only the
/// joins are unchecked, and AND/OR/NOT over valid predicates can't produce invalid SQL.
#[derive(Debug, Clone)]
pub enum Filter {
    True,
    Frag { sql: &'static str, params: Vec<Value> },
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Box<Filter>),
}

impl Filter {
    pub fn render(&self) -> (String, Vec<Value>) {
        let mut sql = String::new();
        let mut params = Vec::new();
        self.write(&mut sql, &mut params);
        (sql, params)
    }

    fn write(&self, sql: &mut String, params: &mut Vec<Value>) {
        match self {
            Filter::True => sql.push('1'),
            Filter::Frag { sql: s, params: p } => {
                sql.push('(');
                sql.push_str(s);
                sql.push(')');
                params.extend(p.iter().cloned());
            }
            Filter::And(fs) | Filter::Or(fs) if fs.is_empty() => sql.push('1'),
            Filter::And(fs) | Filter::Or(fs) => {
                let op = if matches!(self, Filter::And(_)) { " AND " } else { " OR " };
                sql.push('(');
                for (i, f) in fs.iter().enumerate() {
                    if i > 0 { sql.push_str(op) }
                    f.write(sql, params);
                }
                sql.push(')');
            }
            Filter::Not(f) => {
                sql.push_str("NOT ");
                f.write(sql, params);
            }
        }
    }
}

pub fn val<T: ToSql>(x: T) -> Value {
    match x.to_sql().unwrap() {
        ToSqlOutput::Borrowed(r) => Value::try_from(r).unwrap(),
        ToSqlOutput::Owned(v) => v,
        _ => unreachable!(),
    }
}

/// `&[i64]` parameters go in as a JSON array for `json_each(:ids)`.
pub fn json_ids(ids: &[i64]) -> String {
    let mut s = String::from("[");
    for (i, id) in ids.iter().enumerate() {
        if i > 0 { s.push(',') }
        s.push_str(&id.to_string());
    }
    s.push(']');
    s
}
