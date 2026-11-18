#!/bin/bash
# Started by the AWS Lambda Web Adapter (handler: run.sh). Must stay LF + mode 755.
# aws-entry.js loads the secrets from SSM, then starts the HTTP server on $PORT.
exec node dist/aws-entry.js
