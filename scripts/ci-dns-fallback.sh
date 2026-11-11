#!/usr/bin/env bash
# CI-only helper: when a GitHub-hosted runner cannot resolve Ubuntu's package
# mirrors, point systemd-resolved at public resolvers for the rest of the job
# (the host's apt and the Ubuntu containers started with `docker run` follow).
# Changes nothing when the runner's own resolver answers; never fails the job.
#   CI_DNS_FALLBACK_FORCE=1   run outside GitHub Actions (testing)
#   CI_DNS_FALLBACK_DRYRUN=1  print the privileged commands instead of running them

NAMES="azure.archive.ubuntu.com archive.ubuntu.com security.ubuntu.com"
DROPIN=/etc/systemd/resolved.conf.d/90-ci-public-dns.conf

if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${CI_DNS_FALLBACK_FORCE:-}" != 1 ]; then
  echo "ci-dns-fallback: not running under GitHub Actions, nothing to do"
  exit 0
fi
if [ "$(uname -s)" != Linux ]; then
  echo "ci-dns-fallback: not Linux, nothing to do"
  exit 0
fi
if [ "${CI_DNS_FALLBACK_DRYRUN:-}" != 1 ] \
  && { ! command -v systemctl >/dev/null 2>&1 || ! command -v resolvectl >/dev/null 2>&1 \
       || ! systemctl is-active --quiet systemd-resolved; }; then
  echo "ci-dns-fallback: systemd-resolved is not active, nothing to do"
  exit 0
fi

# Prints the names that do not resolve, one per line.
failed_names() {
  local dir n
  dir=$(mktemp -d) || return 0
  for n in $NAMES; do
    ( timeout 25 getent hosts "$n" >/dev/null 2>&1 || echo "$n" >"$dir/$n" ) &
  done
  wait
  for n in $NAMES; do [ -e "$dir/$n" ] && echo "$n"; done
  rm -rf "$dir"
  return 0
}

failed=$(failed_names | tr '\n' ' ')
if [ -z "${failed// /}" ]; then
  echo "ci-dns-fallback: the runner's resolver answers for the Ubuntu mirrors, DNS unchanged"
  exit 0
fi

echo "::warning::Runner resolver cannot resolve: ${failed}- switching this job to public DNS (1.1.1.1, 9.9.9.9, 8.8.8.8)"
conf=$'[Resolve]\nDNS=1.1.1.1 9.9.9.9 8.8.8.8\nDomains=~.'
if [ "${CI_DNS_FALLBACK_DRYRUN:-}" = 1 ]; then
  echo "ci-dns-fallback: dry run, would run:"
  echo "  sudo mkdir -p $(dirname "$DROPIN")"
  echo "  printf '%s\\n' '[Resolve]' 'DNS=1.1.1.1 9.9.9.9 8.8.8.8' 'Domains=~.' | sudo tee $DROPIN"
  echo "  sudo systemctl restart systemd-resolved"
else
  sudo mkdir -p "$(dirname "$DROPIN")" \
    && printf '%s\n' "$conf" | sudo tee "$DROPIN" >/dev/null \
    && sudo systemctl restart systemd-resolved \
    || echo "ci-dns-fallback: could not switch the resolver"
  sleep 2
fi

for n in $NAMES; do
  if timeout 25 getent hosts "$n" >/dev/null 2>&1; then
    echo "ci-dns-fallback: $n resolves"
  else
    echo "ci-dns-fallback: $n still does not resolve"
  fi
done
# Docker copies this file into new containers when the host's resolv.conf is the 127.0.0.53 stub.
echo "ci-dns-fallback: /run/systemd/resolve/resolv.conf:"
grep -v '^#' /run/systemd/resolve/resolv.conf 2>/dev/null | head -n 6 || true
exit 0
