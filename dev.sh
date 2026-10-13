#!/usr/bin/env bash
# Manage the topcoat dev server in the background, bound so other machines can reach it.
# Live reload only works from localhost; remote browsers need a manual refresh.
set -euo pipefail
cd "$(dirname "$0")"

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

STATE_DIR=.dev
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"

usage() {
    cat <<EOF
Usage: ./dev.sh <command> [args]

Commands:
  start [topcoat args]   Start the dev server in the background
  stop                   Stop the dev server
  restart [topcoat args] Stop, then start
  status                 Print whether the server is running (exit 1 if not)
  logs [-f] [-n N]       Print the last N log lines (default 100); -f follows
  grep <pattern>         Search the log (grep -E, case-insensitive)
  run [topcoat args]     Run in the foreground (interactive)

Env: HOST (default 0.0.0.0), PORT (default 3000)
Log: $LOG_FILE (ANSI colors stripped)
EOF
}

running_pid() {
    [[ -f $PID_FILE ]] || return 1
    local pid
    pid=$(<"$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "$pid"
    else
        rm -f "$PID_FILE"
        return 1
    fi
}

cmd_start() {
    if pid=$(running_pid); then
        echo "already running (pid $pid) on http://$HOST:$PORT"
        return 0
    fi
    mkdir -p "$STATE_DIR"
    : >"$LOG_FILE"
    # New session so stop can kill topcoat and the app it spawns as one group.
    # sed strips ANSI escapes so the log stays readable for tools and agents.
    setsid bash -c '
        topcoat dev "$@" </dev/null 2>&1 \
            | sed -u -e "s/\x1b\[[0-9;?]*[A-Za-z]//g" -e "s/\r//g" >>"'"$LOG_FILE"'"
    ' _ "$@" &
    echo $! >"$PID_FILE"

    # Wait for the build to finish and the server to come up.
    local timeout=${START_TIMEOUT:-600}
    for ((i = 0; i < timeout; i++)); do
        if grep -q "ready on" "$LOG_FILE"; then
            echo "started (pid $(<"$PID_FILE")): $(grep -m1 "ready on" "$LOG_FILE" | sed 's/^ *//')"
            return 0
        fi
        if ! running_pid >/dev/null; then
            echo "dev server exited during startup; last log lines:" >&2
            tail -n 30 "$LOG_FILE" >&2
            return 1
        fi
        sleep 1
    done
    echo "still starting after ${timeout}s; check ./dev.sh logs" >&2
    return 1
}

cmd_stop() {
    local pid
    if ! pid=$(running_pid); then
        echo "not running"
        return 0
    fi
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "stopped"
}

cmd_status() {
    if pid=$(running_pid); then
        echo "running (pid $pid) on http://$HOST:$PORT"
    else
        echo "not running"
        return 1
    fi
}

cmd_logs() {
    local follow= lines=100
    while (($#)); do
        case $1 in
            -f | --follow) follow=1 ;;
            -n) lines=$2; shift ;;
            *) echo "unknown logs option: $1" >&2; return 2 ;;
        esac
        shift
    done
    [[ -f $LOG_FILE ]] || { echo "no log yet; run ./dev.sh start" >&2; return 1; }
    if [[ -n $follow ]]; then
        exec tail -n "$lines" -F "$LOG_FILE"
    else
        tail -n "$lines" "$LOG_FILE"
    fi
}

cmd_grep() {
    (($#)) || { echo "usage: ./dev.sh grep <pattern>" >&2; return 2; }
    [[ -f $LOG_FILE ]] || { echo "no log yet; run ./dev.sh start" >&2; return 1; }
    grep -nEi -- "$1" "$LOG_FILE"
}

cmd=${1:-}
shift || true
case $cmd in
    start) cmd_start "$@" ;;
    stop) cmd_stop ;;
    restart) cmd_stop; cmd_start "$@" ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    grep) cmd_grep "$@" ;;
    run) exec topcoat dev "$@" ;;
    -h | --help | help) usage ;;
    *) usage >&2; exit 2 ;;
esac
