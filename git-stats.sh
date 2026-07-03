#!/bin/bash
# Git daily stats — lines added / removed / net per day + total summary

echo ""
echo "=== Git Daily Stats ==="
echo ""

printf "%-12s %8s %8s %8s\n" "Date" "Added" "Removed" "Net"
printf "%-12s %8s %8s %8s\n" "----------" "------" "------" "------"

total_added=0
total_removed=0

git log --reverse --format="%ad" --date=short | sort -u | while read -r day; do
	added=$(git log --after="$day 00:00:00" --before="$day 23:59:59" --date=short --numstat --pretty="" | awk '{ if ($1 != "-") s += $1 } END { print s+0 }')
	removed=$(git log --after="$day 00:00:00" --before="$day 23:59:59" --date=short --numstat --pretty="" | awk '{ if ($2 != "-") s += $2 } END { print s+0 }')
	net=$((added - removed))
	printf "%-12s %8d %8d %8d\n" "$day" "$added" "$removed" "$net"
	total_added=$((total_added + added))
	total_removed=$((total_removed + removed))
done

echo ""
echo "=== Total Summary ==="
echo ""

total_added=$(git log --numstat --pretty="" | awk '{ if ($1 != "-") s += $1 } END { print s+0 }')
total_removed=$(git log --numstat --pretty="" | awk '{ if ($2 != "-") s += $2 } END { print s+0 }')
total_net=$((total_added - total_removed))
total_commits=$(git rev-list --count HEAD)
active_days=$(git log --format="%ad" --date=short | sort -u | wc -l | tr -d ' ')

printf "Added:   %8d lines\n" "$total_added"
printf "Removed: %8d lines\n" "$total_removed"
printf "Net:     %8d lines\n" "$total_net"
printf "Commits: %8d\n" "$total_commits"
printf "Active days: %4d\n" "$active_days"
echo ""
