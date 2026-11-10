#!/bin/sh
# apt-get update + apt-get install with retries, for the package test
# containers (mounted at /scripts). Mirrors are sometimes briefly out of step
# (index and pool disagree: "404 Not Found ... Unable to fetch some archives"),
# so a failed attempt waits, refreshes the index and tries again.
# Usage: sh /scripts/apt-install-retry.sh <apt-get install arguments...>
attempts=3
n=1
while :; do
  if apt-get update && apt-get install -y "$@"; then
    exit 0
  fi
  if [ "$n" -ge "$attempts" ]; then
    echo "apt-install-retry: giving up after $attempts attempts" >&2
    exit 1
  fi
  echo "apt-install-retry: attempt $n/$attempts failed, retrying in 20 s" >&2
  n=$((n + 1))
  sleep 20
done
