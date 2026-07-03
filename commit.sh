#!/bin/sh

REPO="libershare.git"
NAME="LiberSoft"
BRANCH="main"
EMAIL="info@libersoft.org"
USER="libersoft-org"
PASS=$(cat ./.secret_git)

if [ ! -d "./.git/" ]; then
	git init
	git config --global --add safe.directory '*'
	git remote add origin https://$USER:$PASS@github.com/$USER/$REPO
else
	git remote set-url origin https://$USER:$PASS@github.com/$USER/$REPO
fi

bun i -g prettier prettier-plugin-svelte
./prettier-all.sh

git config user.name "$NAME"
git config user.email "$EMAIL"
git status
git add .
git status

if [ "$#" -eq 0 ]; then
	echo "Generating commit message using GitHub Copilot..."
	COMMIT_MSG=$({
		echo "Write exactly one Git commit subject."
		echo "Max 250 characters."
		echo "One line only."
		echo "No prefix."
		echo "No markdown."
		echo "No bullets."
		echo "No explanation."
		echo "No status narration."
		echo "If there are no changes, write exactly: No changes"
		echo
		echo "GIT STATUS:"
		git status --short
		echo
		echo "STAGED DIFF STAT:"
		git diff --cached --stat
		echo
		echo "STAGED DIFF:"
		git diff --cached --unified=0
		echo
		echo "UNSTAGED DIFF STAT:"
		git diff --stat
		echo
		echo "UNSTAGED DIFF:"
		git diff --unified=0
	} | copilot -s --no-ask-user 2>/dev/null)
	if [ -z "$COMMIT_MSG" ] || [ "$COMMIT_MSG" = "No changes" ]; then
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

git commit -m "$COMMIT_MESSAGE"
git push
git status
