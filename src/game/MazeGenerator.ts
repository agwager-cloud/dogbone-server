export type MazeCell = {
  row: number;
  col: number;
  walls: {
    top: boolean;
    right: boolean;
    bottom: boolean;
    left: boolean;
  };
};

export type MazeData = {
  rows: number;
  cols: number;
  cells: MazeCell[];
};

type Wall = keyof MazeCell["walls"];

type Direction = {
  dx: number;
  dy: number;
  wall: Wall;
  opposite: Wall;
};

type Point = {
  row: number;
  col: number;
};

type Entrance = {
  cell: Point;
  wall: Wall;
};

const DIRECTIONS: Direction[] = [
  { dx: 0, dy: -1, wall: "top", opposite: "bottom" },
  { dx: 1, dy: 0, wall: "right", opposite: "left" },
  { dx: 0, dy: 1, wall: "bottom", opposite: "top" },
  { dx: -1, dy: 0, wall: "left", opposite: "right" },
];

function createCell(row: number, col: number): MazeCell {
  return {
    row,
    col,
    walls: {
      top: true,
      right: true,
      bottom: true,
      left: true,
    },
  };
}

function seededRandom(seed: number) {
  let value = seed > 0 ? seed : 1;

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function index(cols: number, row: number, col: number) {
  return row * cols + col;
}

function getCell(cells: MazeCell[], cols: number, row: number, col: number) {
  return cells[index(cols, row, col)];
}

function isInside(rows: number, cols: number, row: number, col: number) {
  return row >= 0 && row < rows && col >= 0 && col < cols;
}

function getCentre(rows: number, cols: number): Point {
  return {
    row: Math.floor(rows / 2),
    col: Math.floor(cols / 2),
  };
}

function getEntrances(rows: number, cols: number): Entrance[] {
  const middleRow = Math.floor(rows / 2);
  const middleCol = Math.floor(cols / 2);

  return [
    {
      cell: { row: 0, col: middleCol },
      wall: "top",
    },
    {
      cell: { row: middleRow, col: cols - 1 },
      wall: "right",
    },
    {
      cell: { row: rows - 1, col: middleCol },
      wall: "bottom",
    },
    {
      cell: { row: middleRow, col: 0 },
      wall: "left",
    },
  ];
}

function removeWallBetween(
  cells: MazeCell[],
  rows: number,
  cols: number,
  from: Point,
  to: Point,
) {
  if (!isInside(rows, cols, from.row, from.col)) return;
  if (!isInside(rows, cols, to.row, to.col)) return;

  const rowDiff = to.row - from.row;
  const colDiff = to.col - from.col;

  if (Math.abs(rowDiff) + Math.abs(colDiff) !== 1) return;

  const fromCell = getCell(cells, cols, from.row, from.col);
  const toCell = getCell(cells, cols, to.row, to.col);

  if (rowDiff === -1) {
    fromCell.walls.top = false;
    toCell.walls.bottom = false;
    return;
  }

  if (rowDiff === 1) {
    fromCell.walls.bottom = false;
    toCell.walls.top = false;
    return;
  }

  if (colDiff === -1) {
    fromCell.walls.left = false;
    toCell.walls.right = false;
    return;
  }

  if (colDiff === 1) {
    fromCell.walls.right = false;
    toCell.walls.left = false;
  }
}

function createPerfectMaze(
  rows: number,
  cols: number,
  seed: number,
): MazeCell[] {
  const cells: MazeCell[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push(createCell(row, col));
    }
  }

  const random = seededRandom(seed);
  const visited = new Array(rows * cols).fill(false);

  const centre = getCentre(rows, cols);
  const startIndex = index(cols, centre.row, centre.col);
  const stack: number[] = [startIndex];

  visited[startIndex] = true;

  while (stack.length > 0) {
    const currentIndex = stack[stack.length - 1];
    const row = Math.floor(currentIndex / cols);
    const col = currentIndex % cols;

    const neighbours = shuffle(DIRECTIONS, random).flatMap((direction) => {
      const nextRow = row + direction.dy;
      const nextCol = col + direction.dx;

      if (!isInside(rows, cols, nextRow, nextCol)) return [];

      const nextIndex = index(cols, nextRow, nextCol);

      if (visited[nextIndex]) return [];

      return [
        {
          direction,
          nextIndex,
          point: { row: nextRow, col: nextCol },
        },
      ];
    });

    if (neighbours.length === 0) {
      stack.pop();
      continue;
    }

    const next = neighbours[0];

    removeWallBetween(cells, rows, cols, { row, col }, next.point);

    visited[next.nextIndex] = true;
    stack.push(next.nextIndex);
  }

  return cells;
}

function openTeamEntrances(cells: MazeCell[], rows: number, cols: number) {
  for (const entrance of getEntrances(rows, cols)) {
    const cell = getCell(cells, cols, entrance.cell.row, entrance.cell.col);
    cell.walls[entrance.wall] = false;
  }
}

function centreWouldHaveStraightTunnel(openWalls: Set<Wall>, candidate: Wall) {
  const testWalls = new Set(openWalls);
  testWalls.add(candidate);

  const verticalTunnel = testWalls.has("top") && testWalls.has("bottom");
  const horizontalTunnel = testWalls.has("left") && testWalls.has("right");

  return verticalTunnel || horizontalTunnel;
}

function ensureCentreHasReadableAccess(
  cells: MazeCell[],
  rows: number,
  cols: number,
  seed: number,
) {
  const centre = getCentre(rows, cols);
  const centreCell = getCell(cells, cols, centre.row, centre.col);
  const random = seededRandom(seed + 991);

  const possibleDirections = DIRECTIONS.filter((direction) =>
    isInside(rows, cols, centre.row + direction.dy, centre.col + direction.dx),
  );

  const openWalls = new Set<Wall>();

  for (const direction of possibleDirections) {
    if (!centreCell.walls[direction.wall]) {
      openWalls.add(direction.wall);
    }
  }

  // One doorway is technically reachable, but it can look blocked under the bone.
  // Two doorways makes the objective feel fair without creating a straight cross-road.
  while (openWalls.size < 2) {
    const candidates = shuffle(possibleDirections, random);

    const preferred = candidates.find(
      (direction) =>
        centreCell.walls[direction.wall] &&
        !centreWouldHaveStraightTunnel(openWalls, direction.wall),
    );

    const fallback = candidates.find(
      (direction) => centreCell.walls[direction.wall],
    );

    const chosen = preferred ?? fallback;
    if (!chosen) break;

    removeWallBetween(cells, rows, cols, centre, {
      row: centre.row + chosen.dy,
      col: centre.col + chosen.dx,
    });

    openWalls.add(chosen.wall);
  }
}

function findDistanceToCentre(
  cells: MazeCell[],
  rows: number,
  cols: number,
  start: Point,
): number | null {
  const centre = getCentre(rows, cols);
  const queue: Point[] = [start];
  const distances = new Map<string, number>();

  distances.set(`${start.row},${start.col}`, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = `${current.row},${current.col}`;
    const currentDistance = distances.get(currentKey) ?? 0;

    if (current.row === centre.row && current.col === centre.col) {
      return currentDistance;
    }

    const currentCell = getCell(cells, cols, current.row, current.col);

    for (const direction of DIRECTIONS) {
      if (currentCell.walls[direction.wall]) continue;

      const nextRow = current.row + direction.dy;
      const nextCol = current.col + direction.dx;

      if (!isInside(rows, cols, nextRow, nextCol)) continue;

      const nextKey = `${nextRow},${nextCol}`;

      if (distances.has(nextKey)) continue;

      distances.set(nextKey, currentDistance + 1);
      queue.push({ row: nextRow, col: nextCol });
    }
  }

  return null;
}

function getEntranceDistances(
  cells: MazeCell[],
  rows: number,
  cols: number,
): number[] | null {
  const distances = getEntrances(rows, cols).map((entrance) =>
    findDistanceToCentre(cells, rows, cols, entrance.cell),
  );

  if (distances.some((distance) => distance === null)) {
    return null;
  }

  return distances as number[];
}

function scoreMaze(distances: number[], rows: number, cols: number) {
  const shortest = Math.min(...distances);
  const longest = Math.max(...distances);

  const idealShortest = Math.max(10, Math.floor((rows + cols) * 0.75));
  const idealLongest = Math.max(
    idealShortest + 8,
    Math.floor(rows * cols * 0.48),
  );

  const tooEasyPenalty = Math.max(0, idealShortest - shortest) * 8;
  const tooHardPenalty = Math.max(0, longest - idealLongest) * 2;
  const balancePenalty = (longest - shortest) * 0.35;

  return tooEasyPenalty + tooHardPenalty + balancePenalty;
}

export function generateMaze(rows: number, cols: number, seed = 1): MazeData {
  let bestCells: MazeCell[] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  // Try a few deterministic candidates and keep the fairest one.
  // This avoids random mazes that are accidentally too direct or too annoying.
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidateSeed = seed + attempt * 137;
    const cells = createPerfectMaze(rows, cols, candidateSeed);

    openTeamEntrances(cells, rows, cols);
    ensureCentreHasReadableAccess(cells, rows, cols, candidateSeed);

    const distances = getEntranceDistances(cells, rows, cols);

    if (!distances) continue;

    const score = scoreMaze(distances, rows, cols);

    if (score < bestScore) {
      bestScore = score;
      bestCells = cells;
    }

    const shortest = Math.min(...distances);
    const longest = Math.max(...distances);

    const shortestIsFair =
      shortest >= Math.max(10, Math.floor((rows + cols) * 0.7));
    const longestIsFair =
      longest <= Math.max(22, Math.floor(rows * cols * 0.52));
    const routesAreBalanced =
      longest - shortest <= Math.max(14, Math.floor(rows * cols * 0.22));

    if (shortestIsFair && longestIsFair && routesAreBalanced) {
      bestCells = cells;
      break;
    }
  }

  if (!bestCells) {
    bestCells = createPerfectMaze(rows, cols, seed);
    openTeamEntrances(bestCells, rows, cols);
    ensureCentreHasReadableAccess(bestCells, rows, cols, seed);
  }

  return {
    rows,
    cols,
    cells: bestCells,
  };
}
