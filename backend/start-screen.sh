#!/bin/sh

ARGS="$*"
screen -dmS lish-backend bash -c ". ./colors.sh; trap bash SIGINT; (./start.sh $ARGS ; bash);"
