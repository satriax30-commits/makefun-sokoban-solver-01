# makefun-sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/satriax30-commits/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/satriax30-commits/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

**Push-optimal Sokoban solver** — one program answers all 5 instances of a set in one run, in as few pushes as possible.

## How it works

Every level this generator draws is a hallway with one to four rooms off it, each room holding 3 or 4 boxes and as many goals — and a box pushed out of a room's door can never come back. So a level's push-optimal count is the sum of its rooms' optima, and the rooms solve independently. This program cuts the level into rooms, then solves each room on its own with an A* over pushes and concatenates the move strings, the player walking on from where the last room left it.

A search state is the boxes' squares plus the player's reachable region (named by its lowest square). The heuristic is the cheapest matching of boxes to goals by grid distance, which never overestimates — one push moves one box one square. Dead positions are pruned: squares from which no pull backwards reaches a goal, boxes caught in frozen 2×2 blocks of walls and boxes, and boxes frozen against walls and boxes that can never move again. The first solved state the search pops is push-optimal, so each room costs its optimum and the level costs the sum.

Pure and deterministic: no clock, no randomness, no network. The search is bounded by states kept (250,000 per room), never by time, so two runs write the same bytes.

## Run it

```sh
node main.ts
```

Reads `/input/<id>/level.txt` (XSB) and writes `/output/<id>/solution.txt` (LURD moves, one letter a step; an upper letter marks a push). Outside a container, set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`.

## Practice results

| Instance | Boxes | Push-optimal (P*) | Solver pushes | Points |
| --- | --- | --- | --- | --- |
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

**Practice score: 1,000,000 / 1,000,000** in ~1 second for the whole set (60-second budget). The house baseline, plain-astar 1.0.0, scores 200,000 on the same set — it solves only i001 and gives up on the rest. The solver was also checked on 6 freshly drawn sets from the kit's generator (30 instances): all solved at exactly P*, 1,000,000 each, with at most ~2,000 states kept per room against the 250,000 budget.

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=kssgyf66&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
