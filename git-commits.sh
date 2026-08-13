#!/usr/bin/env bash
# List every commit with its subject and line changes, then print total changes.
set -euo pipefail

NUMBER_WIDTH=5
DATE_WIDTH=23
MESSAGE_WIDTH=50
COUNT_WIDTH=8

usage() {
	echo "usage: git-commits.sh [commit-count]" >&2
	exit 2
}

if (($# > 1)); then
	usage
fi

commit_count="${1:-}"
if [[ -n "$commit_count" && ! "$commit_count" =~ ^[1-9][0-9]*$ ]]; then
	echo "git-commits: commit-count must be a positive integer" >&2
	usage
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
	echo "git-commits: not inside a Git repository" >&2
	exit 1
}
cd "$repo_root"

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
	echo "git-commits: repository has no commits" >&2
	exit 1
fi

# The hash and the date get colours of their own so a row reads as separate
# fields. The row number keeps the terminal's own colour: it is an index, and
# colouring everything is the same as colouring nothing.
if [[ -t 1 ]]; then
	RED=$'\033[31m'
	GREEN=$'\033[32m'
	NET_PLUS=$'\033[93m'
	NET_MINUS=$'\033[38;5;130m'
	HASH_COLOUR=$'\033[36m'
	# 208 rather than the 130 the negative net uses, so the two oranges in a row
	# are not mistaken for each other.
	DATE_COLOUR=$'\033[38;5;208m'
	RESET=$'\033[0m'
else
	RED=""
	GREEN=""
	NET_PLUS=""
	NET_MINUS=""
	HASH_COLOUR=""
	DATE_COLOUR=""
	RESET=""
fi

separator() {
	printf '%*s' "$1" '' | tr ' ' '-'
}

log_args=(--reverse)
number_offset=0
if [[ -n "$commit_count" ]]; then
	log_args+=(--max-count="$commit_count")
	# A count selects the newest commits, so the first row listed is not the first commit.
	# Number rows by their real position in the whole history rather than within the window.
	total_commits="$(git rev-list --count HEAD)"
	if ((commit_count < total_commits)); then
		number_offset=$((total_commits - commit_count))
	fi
fi

# Header cells carry the same colour as the column below them, which is what
# makes the mapping readable without counting fields.
printf '%*s %s%-7s%s %s%-*s%s %-*s %*s %*s %*s\n' \
	"$NUMBER_WIDTH" "#" \
	"$HASH_COLOUR" "Commit" "$RESET" \
	"$DATE_COLOUR" "$DATE_WIDTH" "Date" "$RESET" \
	"$MESSAGE_WIDTH" "Message" \
	"$COUNT_WIDTH" "Removed" "$COUNT_WIDTH" "Added" "$COUNT_WIDTH" "Net"
printf '%s %-7s %-*s %-*s %s %s %s\n' "$(separator "$NUMBER_WIDTH")" "-------" \
	"$DATE_WIDTH" "$(separator "$DATE_WIDTH")" \
	"$MESSAGE_WIDTH" "$(separator "$MESSAGE_WIDTH")" \
	"$(separator "$COUNT_WIDTH")" "$(separator "$COUNT_WIDTH")" "$(separator "$COUNT_WIDTH")"

# One traversal carries identity, subject and diff totals together. Asking git per commit
# costs four processes each, and columns sized from the widest row cannot print until the
# whole walk ends; fixed widths let every row leave as soon as it is read.
#
# The date is the *author* date, which is when the work was done and survives a
# rebase, rather than when the commit last entered this history. `format-local`
# with `TZ=UTC` renders it in UTC instead of whatever zone each commit recorded,
# so two rows are comparable - and the zone is written into every row rather than
# only into the heading, so a row pasted somewhere else still says what it means.
TZ=UTC git log "${log_args[@]}" --numstat \
	--date=format-local:'%Y-%m-%d %H:%M:%S UTC' --format=$'\x01%h\x02%ad\x02%s' HEAD |
	awk -v number_width="$NUMBER_WIDTH" -v number_offset="$number_offset" \
		-v date_width="$DATE_WIDTH" \
		-v message_width="$MESSAGE_WIDTH" -v count_width="$COUNT_WIDTH" \
		-v red="$RED" -v green="$GREEN" -v net_plus="$NET_PLUS" \
		-v net_minus="$NET_MINUS" -v reset="$RESET" \
		-v hash_colour="$HASH_COLOUR" -v date_colour="$DATE_COLOUR" '
		function emit(net, subject, net_colour) {
			if (!pending) return
			listed += 1
			total_added += added
			total_removed += removed
			net = added - removed
			subject = message
			if (length(subject) > message_width) {
				subject = substr(subject, 1, message_width - 3) "..."
			}
			net_colour = net < 0 ? net_minus : net_plus
			# Colour wraps each padded field rather than sitting inside it,
			# because the escape bytes would otherwise count toward the width.
			printf "%*d %s%-7s%s %s%-*s%s %-*s %s%*s%s %s%*s%s %s%*s%s\n", \
				number_width, number_offset + listed, \
				hash_colour, hash, reset, \
				date_colour, date_width, date, reset, \
				message_width, subject, \
				red, count_width, "-" removed, reset, \
				green, count_width, "+" added, reset, \
				net_colour, count_width, sprintf("%+d", net), reset
			pending = 0
		}
		substr($0, 1, 1) == "\001" {
			emit()
			record = substr($0, 2)
			split(record, field, "\002")
			hash = field[1]
			date = field[2]
			# Taken by offset rather than as field[3], so a subject containing the
			# separator stays whole.
			message = substr(record, length(field[1]) + length(field[2]) + 3)
			added = 0
			removed = 0
			pending = 1
			next
		}
		# Binary files report "-" for both counts and contribute no line total.
		$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
			added += $1
			removed += $2
		}
		END {
			emit()
			total_net = total_added - total_removed
			printf "\nSummary (%d commits)\n", listed
			printf "Removed: %s%*s%s\n", red, count_width, "-" total_removed, reset
			printf "Added:   %s%*s%s\n", green, count_width, "+" total_added, reset
			printf "Net:     %s%*s%s\n", total_net < 0 ? net_minus : net_plus, \
				count_width, sprintf("%+d", total_net), reset
		}
	'
