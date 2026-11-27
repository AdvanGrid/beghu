#!/bin/sh
# Installs beghu, the command-line client of the beghu at @HOST@, built from the same commit as
# it (beghu @VERSION@, build @BUILD@):
#
#   curl -fsSL @HOST@/cli/install.sh | sh
#
# into $BEGHU_INSTALL_DIR, or ~/.local/bin, with no sudo. Linux (x86_64, aarch64) and macOS (Apple
# silicon, Intel). On Windows, run it inside WSL: beghu has no native Windows build.
set -eu

# Everything is in main, called on the last line: a download cut short defines at most part of a
# function, and runs nothing.
fail() {
  echo "install.sh: $*" >&2
  exit 1
}

main() {
  host='@HOST@'
  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      fail "beghu has no native Windows build: run this inside WSL, which installs the Linux one" ;;
    *) fail "beghu has no build for $(uname -s)" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) fail "beghu has no build for $(uname -m)" ;;
  esac
  platform=$os-$arch
  case $platform in
@SHA256S@
    *) fail "$host serves no beghu build for $platform" ;;
  esac

  dir=${BEGHU_INSTALL_DIR:-$HOME/.local/bin}
  mkdir -p "$dir"
  tmp=$(mktemp "$dir/.beghu.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL -A 'beghu-install' -o "$tmp" "$host/cli/$platform/beghu"
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp" | cut -d ' ' -f 1)
  else
    got=$(shasum -a 256 "$tmp" | cut -d ' ' -f 1)
  fi
  [ "$got" = "$want" ] || fail "the download's SHA-256 is $got, not $want as $host's manifest says"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$dir/beghu"
  trap - EXIT
  echo "installed beghu @VERSION@ (build @BUILD@) from $host to $dir/beghu"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "$dir isn't on your PATH: add it, or run $dir/beghu" ;;
  esac
  echo "next: beghu login@LOGIN_HOST@"
}

main "$@"
