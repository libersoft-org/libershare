#!/bin/sh

ARGS="$*"
screen -dmS lish-frontend bash -c ". ./colors.sh; trap bash SIGINT; (./start-dev.sh $ARGS ; bash);"
