# movielist

Personal tool for managing and normalizing a movie/TV show library.

The script scans a video collection, detects files whose name doesn't follow the expected naming convention, suggests a corrected name based on [TMDB](https://www.themoviedb.org/), and generates several statistical reports (duplicates, largest files, watch rate, movies by favorite actor/director, etc.).

## Features

- Detects malformed filenames using regular expressions and automatically suggests the correct name via the TMDB API.
- Extracts video/audio metadata (codec, resolution, HDR, audio tracks, subtitles) via `mediainfo`.
- Fetches and caches TMDB covers / details.
- Detects duplicates (title + year, including original title).
- Generates reports: largest/smallest files, addition history, movies by tracked actor/director, top 4K, list sorted by age.
- Automatically moves new downloads to the target folders (movies / ebooks).
- Cleans up empty folders and `Thumbs.db` files.
- Local metadata cache (compressed, MessagePack format) to speed up subsequent runs.

## Requirements

- [Node.js](https://nodejs.org/) >= 26
- [MediaInfo](https://mediaarea.net/en/MediaInfo) installed and available (CLI)
- A [TMDB](https://www.themoviedb.org/settings/api) API key

## Installation

```bash
npm install
```

## Configuration

### Environment variables

Create a `.env` file at the project root (not versioned):

```env
PATH_RO=/read-only-path
PATH_RW=/read-write-path
DOCUMENT_PATH=document
CONFIGURATION_PATH=./configuration
MEDIAINFO=/usr/bin/mediainfo
METACACHE_PATH_MP=/path/to/metacache
TMDB_API_KEY=your_api_key
```

### Configuration files

The `configuration/` folder contains the lists and settings used by the script. Some files are personal and intentionally excluded from the repo (see `.gitignore`):

| File | Description | Versioned |
|---|---|---|
| `paths.json` | Paths for video folders, disks, archives, downloads | No |
| `wellKnownActors.txt` | Actors to flag in casts | No |
| `wellknowndirectors.txt` | Directors to flag | No |
| `duplicateexceptions.txt` | Titles excluded from duplicate detection | No |
| `collectionactors.txt` | Actors tracked for the dedicated report | No |
| `seriesToCheck.txt` | Series to analyze | No |
| `cleanReplacements.txt` | Strings to strip from raw titles | No |
| `excludedFolders.txt` | Folders to ignore when walking the tree | No |
| `videotagexceptions.txt` | Exceptions for video tag checking | No |
| `prepositions.txt` | Prepositions not to capitalize | Yes |
| `genres.txt` | List of recognized genres | Yes |

Adjust the non-versioned files to your own library before the first run.

## Usage

```bash
node movielist.mjs
```

An optional numeric argument limits how many malformed files are processed in a single run; further arguments filter files by name (case-insensitive regex):

```bash
node movielist.mjs 20 star wars
```

### Lint

```bash
npm run lint
npm run lint:fix
```

## Generated output

Reports are written to `DOCUMENT_PATH` (subfolder of `PATH_RW`):

- `movie-list.txt` — full list with metadata
- `movie-plainlist.txt` — list sorted by name
- `movie-timesort.txt` — unseen movies sorted by date added
- `movie-timelapse.txt` — history of the last 200 additions
- `movie-oldest.txt` — oldest file per category
- `movie-4k.txt` — unseen 4K movies sorted by size
- `movie-duplicate.txt` — detected duplicates
- `movie-collactor.txt` — stats and movies for tracked actors/directors
- `movie-output.txt` — execution log

## License

ISC — see the `license` field in `package.json`.

## Disclaimer

Personal project, not intended for generic reuse: the naming regular expressions and folder structure follow a convention specific to the author.
