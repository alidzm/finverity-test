#!/bin/bash
# Creates the topics used by the service (auto-creation is disabled on the broker).
set -euo pipefail

BOOTSTRAP=kafka:19092

create() {
  local topic=$1 partitions=$2
  shift 2
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
    --topic "$topic" --partitions "$partitions" --replication-factor 1 "$@"
}

# Inbound from treasury. Keyed by programId → per-program ordering.
create treasury.program-capacity.v1 6
create treasury.program-capacity.v1.dlq 1
# Latest rate per currency pair → log compaction.
create treasury.fx-rates.v1 3 --config cleanup.policy=compact
create treasury.fx-rates.v1.dlq 1
# Outbound events from this service (transactional outbox). Keyed by programId.
create capacity.events.v1 6

/opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list
