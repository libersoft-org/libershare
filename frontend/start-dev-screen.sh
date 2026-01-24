#!/bin/sh

screen -dmS lish-frontend bash -c ". ./colors.sh; trap bash SIGINT; (./start-dev.sh ; bash);"
