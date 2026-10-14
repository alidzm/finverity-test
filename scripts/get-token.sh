#!/usr/bin/env bash
# Prints an access token from the local Keycloak (client-credentials grant).
#
#   export TOKEN=$(./scripts/get-token.sh)                    # invoice-service: read+reserve+release
#   export TOKEN=$(./scripts/get-token.sh capacity-reader)    # read only
set -euo pipefail

CLIENT_ID=${1:-invoice-service}
CLIENT_SECRET=${2:-${CLIENT_ID}-secret}
KEYCLOAK_URL=${KEYCLOAK_URL:-http://localhost:8080}

curl -sf -X POST "${KEYCLOAK_URL}/realms/capacity/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))'
