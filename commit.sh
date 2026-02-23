#!/bin/sh

REPO="libershare.git"
NAME="LiberSoft"
BRANCH="main"
EMAIL="info@libersoft.org"
USER="libersoft-org"
PASS=$(cat ./.secret_git)

if [ "$#" -eq 0 ]; then
	echo "Generating commit message using GitHub Copilot..."
	COMMIT_MSG=$(gh copilot explain "Analyze the changes in the following context and write a brief commit message with max. 50 characters. All in one line. Do not write anything else. No chitchat at the beginning or end. Here is the list of changes: $(git diff)" 2>/dev/null | grep -A2 "Explanation" | tail -1 | sed 's/^[ \t]*//' | sed 's/[ \t]*$//')
	if [ -z "$COMMIT_MSG" ]; then
		echo "\033[31mERROR:\033[0m Failed to generate commit message. Please provide one manually:"
		echo "Usage: $0 \"[COMMIT MESSAGE]\""
		exit 1
	fi
	# Clean the commit message - remove quotes and sanitize
	COMMIT_MSG=$(echo "$COMMIT_MSG" | sed 's/"//g' | sed "s/'//g")
	echo "\033[33mGENERATED COMMIT MESSAGE:\033[0m $COMMIT_MSG"
	COMMIT_MESSAGE="$COMMIT_MSG"
else
	# Sanitize user-provided message
	COMMIT_MESSAGE=$(echo "$1" | sed 's/"//g' | sed "s/'//g")
fi

if [ ! -d "./.git/" ]; then
	git init
	git config --global --add safe.directory '*'
	git remote add origin https://$USER:$PASS@github.com/$USER/$REPO
else
	git remote set-url origin https://$USER:$PASS@github.com/$USER/$REPO
fi
#bun i -g prettier prettier-plugin-svelte
#prettier --plugin 'prettier-plugin-svelte' --write "src/**/*.{js,ts,css,html,svelte}"
git config user.name "$NAME"
git config user.email "$EMAIL"
git status
git add .
git status
git commit -m "$COMMIT_MESSAGE"
git push
git status
