#!/bin/sh
set -eu

node ./node_modules/prisma/build/index.js migrate deploy
exec node apps/api/dist/main.js
