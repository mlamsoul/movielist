import { join, parse, sep } from 'path';
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { gzip, gunzip } from 'zlib';
import { reset, BGred } from './utils/ansicolor.mjs';
import { reLanguage, reCountry } from './utils/iso.mjs';
import 'dotenv/config'; // before any other imports, to ensure .env is loaded first
import { tmdb } from './utils/tmdb.mjs';
import { Writer } from './Writer.mjs';
import { MovieSpecs } from './MovieSpecs.mjs';
import { encode, decode } from '@msgpack/msgpack';

const __dirname = import.meta.dirname;
const execFileAsync = promisify(execFile);
const fmt = new Intl.DurationFormat('en', { style: 'long' });
const { PATH_RO, PATH_RW, DOCUMENT_PATH } = process.env;
const documentRO = join(PATH_RO, DOCUMENT_PATH || 'document');
const documentRW = join(PATH_RW, DOCUMENT_PATH || 'document');
const write = new Writer(PATH_RO, PATH_RW);
const configuration = process.env.CONFIGURATION_PATH || join(__dirname, 'configuration');
const mediainfo = process.env.MEDIAINFO;

const YEAR_TOLERANCE = 1;
const skipPhysical = true;
const skipCover = false;
const DRIVELETTERS = 'DEFGHIJKL';
const NO_SUGGESTION = { suggestedName: undefined, id: undefined };

const reTitle = '(?:.*)';
const reTitleYear = /(?<title>.*) \((?<titleVO>.*?)\s?(?<year>(?:19|20)\d\d).*/;
const reDate = /(?:.*(?<date>\d{4})(?!.*(?:Disney|Marvel|Ghibli)).*)/; // original title + date + actor/company
const regIsSerie = /(.*?)\s*((?:19|20)\d\d)?(?:\((.*?)((?:19|20)\d\d)?\))?\s*S(\d?\d) ?E(\d?\d?\d)(.*((?:19|20)\d\d)+|.*)/i;
const reSubt = 'ST(?:FR|EN|NL|IT|DE)?';

const reExceptions = /.txt$|.cbr$|.blu$|.dvd$|\[sketch|\[extra|\[youtube|\[short|\[trailer|\[clip|\[tutorial/;
const noSuggestion = /(\[extra|\[tutorial|\[série|\[sketch|\[short|\[clip|\.ts$|\.srt$)/i;

const LANG_MAP = new Map([
  ['zxx', 'zxx'],
  ['en-us', 'en'],
  ['Español', 'es'],
  ['Italiano', 'it'],
  ['Français', 'fr'],
  ['Francais', 'fr'],
  ['French_Canadian', 'fr'],
  ['French_Parisian', 'fr'],
]);

const STUDIO_MAP = new Map([
  ['Walt Disney Pictures', 'disney'],
  ['Walt Disney Productions', 'disney'],
  ['Disney Television Animation', 'disney'],
  ['Disney Channel', 'disney'],
  ['Walt Disney Television', 'disney'],
  ['Leslie Iwerks Productions', 'disney'],
  ['Walt Disney Animation Japan', 'disney'],
  ['Disneynature', 'disneynature'],
  ['Marvel Studios', 'marvel'],
  ['Marvel Enterprises', 'marvel'],
  ['Marvel Entertainment', 'marvel'],
  ['DreamWorks Animation', 'dreamworks'],
  ['DreamWorks Pictures', 'dreamworks'],
  ['DreamWorks Television', 'dreamworks'],
  ['Studio Ghibli', 'ghibli'],
  ['Pixar', 'pixar'],
  ['Marc Dorcel', 'Marc Dorcel'],
  ['ARTE', 'arte'],
]);

const LANG_CODE_MAP = {
  undefined: 'VO',
  fr: 'FR',
  en: 'EN',
  es: 'ES',
  it: 'IT',
  de: 'DE',
  no: 'NO',
  sv: 'SV',
  ja: 'JP',
  pt: 'PT',
  zh: 'ZH',
  bn: 'BN',
  hi: 'HI',
  fa: 'FA',
  hu: 'HU',
  ru: 'RU',
  te: 'TE',
  cs: 'CS',
  zxx: 'SILENT',
};

const plural = (i) => (i > 1 ? 's' : '');

const parseConfigLine = (line) => {
  const match = line.match(/^\/(.+)\/([gimsuy]*)$/);
  return match ? new RegExp(match[1], match[2]) : line;
};

const fileExists = async (path) =>
  fs.access(path).then(
    () => true,
    () => false,
  );

const readConfigFiles = async (filename) =>
  (await fs.readFile(join(configuration, filename), 'utf-8'))
    .split('\n')
    .map((line) => line.replace(/\/\*.*?\*\//g, '').trim()) // Remove comments and trim whitespace
    .filter((line) => line.length > 0) // Remove empty lines
    .map(parseConfigLine);

const [
  wellKnownActors,
  wellKnownDirectors,
  duplicateExceptions,
  collectionActorsList,
  seriesToCheck,
  cleanReplacements,
  prepList,
  genreList,
  excludedFolders,
  videoTagExceptions,
] = await Promise.all([
  readConfigFiles('wellKnownActors.txt'),
  readConfigFiles('wellKnownDirectors.txt'),
  readConfigFiles('duplicateExceptions.txt'),
  readConfigFiles('collectionActors.txt'),
  readConfigFiles('seriesToCheck.txt'),
  readConfigFiles('cleanReplacements.txt'),
  readConfigFiles('prepositions.txt'),
  readConfigFiles('genres.txt'),
  readConfigFiles('excludedFolders.txt'),
  readConfigFiles('videoTagExceptions.txt'),
]);

const prepSet = new Set(prepList);
const excludedFoldersSet = new Set(excludedFolders);
const duplicateExceptionsSet = new Set(duplicateExceptions);
const collectionactors = Object.fromEntries(collectionActorsList.map((actor) => [actor, []]));

const plainlist = [];
const fourklist = [];

const ENCODING_TABLE = {
  AVC: 'x264',
  HEVC: 'x265',
  'MPEG Video': 'MPEG',
  'MPEG-4 Visual': 'MPEG4',
};

const reGenre = genreList.join('|').replace(/-/g, '\\-');
const reGenreCountry = `(?:(?:${reGenre}) )+(?:${reCountry})+`;
const reQuality = '(?: (?<quality>SD|720p|1080p|4K|3D))'; // (?:   non-capturing group
const reQuality2 = '(?: (?<quality2>SD|720p|1080p|4K|3D))'; // (?:   non-capturing group
const reHDR = '(?: HDR)?';
const reAudioFormat = [
  'AAC_1.0',
  'AAC_2.0',
  'AAC_2.1',
  'AAC_3.0',
  'AAC_5.1',
  'AC3_1.0',
  'AC3_2.0',
  'AC3_2.1',
  'AC3_5.0',
  'AC3_5.1',
  'AC3Plus_7.1',
  'ALAW_2.0',
  'TrueHD_2.0',
  'TrueHD_5.1',
  'TrueHD_7.1',
  'TrueHD_Atmos_5.1',
  'TrueHD_Atmos_7.1',
  'DTS_1.0',
  'DTS_2.0',
  'DTS_2.1',
  'DTS_4.0',
  'DTS_5.0',
  'DTS_5.1',
  'DTS_7.1',
  'DTS-ES_6.1',
  'DTSHR_5.1',
  'DTSHR_7.1',
  'DTSHDRA_5.1',
  'DTSMA_1.0',
  'DTSMA_2.0',
  'DTSMA_2.1',
  'DTSMA_5.0',
  'DTSMA_5.1',
  'DTSMA_6.1',
  'DTSMA_7.1',
  'DTSX_7.1',
  'EAC3_1.0',
  'EAC3_2.0',
  'EAC3_5.1',
  'EAC3_7.1',
  'FLAC_1.0',
  'FLAC_2.0',
  'FLAC_5.1',
  'LPCM_1.0',
  'LPCM_2.0',
  'MP1_2.0',
  'MP2_2.0',
  'MP3_1.0',
  'MP3_2.0',
  'OGG_1.0',
  'OGG_2.0',
  'OGG_5.1',
  'OPUS_1.0',
  'OPUS_5.1',
  'PCM_1.0',
  'PCM_2.0',
  'RAW_2.0',
  'WMA_1.0',
  'WMA_2.0',
  'WMA_5.1',
  'NONE',
].join('|');

const reEpisode = '(?:.*?)';
const reLangSubExt = /\.(eng|fre|dut|ger|ita)/;
const reLangSubExtEnd = new RegExp(`${reLangSubExt.source}$`);
const reNormal = `${reTitle} ${reDate.source} - (?:${reLanguage})(${reSubt})? \\[${reGenreCountry}\\]${reQuality}${reHDR}(?: (?:${reAudioFormat}))(${reLangSubExt.source})?$`;

const reExtra = `${reTitle} \\[extra( makeof)?( trailer)?( us)?\\]$)|(.* \\[tutorial\\]$)|(.* \\[tv\\]$)|(.* \\[clip\\]$)|(.* \\[short.*\\]$`;
const reSerie = new RegExp(`${reTitle} S(19|20)?\\d\\dEP?\\d?\\d\\d[a-c]? (FINAL )?- ${reEpisode}(?:${reQuality2}${reHDR}(?: (?:${reAudioFormat})))?$`);
const reAll = new RegExp(`(?:${reNormal})|(?:${reExtra})|(?:${reSerie.source})`); // case is important

const reLookFrench = /FRENCH|\bVF\b|\bVFF\b|\bVOF\b|\bFR\b|truefrench|\) - FR \[/i;
const reLookMulti = /multilangues/i;

const extVideo = new Set(['mkv', 'avi', 'mpg', 'mpeg', 'mp4', 'm4v', 'divx', 'm2ts', 'vob', 'ts', '3g', 'mov', 'wmv', 'iso']);
const extEBook = new Set(['cbz', 'cbr', 'pdf']);
const extSubt = new Set(['srt', 'sub', 'ass', 'idx', 'txt', 'ssa']);
const extDisk = new Set(['blu', 'dvd', 'mp3']);
const extCover = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const pathsConfig = JSON.parse(await fs.readFile(join(configuration, 'paths.json'), 'utf-8'));
const seriesPath = seriesToCheck.map((s) => ({ path: join(pathsConfig.seriesBasePath, s), seen: false }));
const videoDisks = pathsConfig.videoDisks.map(({ path: p, seen }) => ({ path: join(documentRO, p), seen }));
const videoPaths = [...pathsConfig.videoPaths, ...seriesPath];
const { downloadPaths, targetVideoPath, targetEBookPath } = pathsConfig;

const archiveDisks = [...pathsConfig.archiveLetters].map((l) => ({ path: `${pathsConfig.archiveDiskPrefix} ${l}` })); // DISK A, DISK B, ...
// const archiveDisks = [...'ABCDEFGHIJKL'].map((l) => ({ path: `DISK ${l}` }));

const color =
  (clr) =>
  (s, ...v) =>
    `${clr}${String.raw({ raw: s }, ...v)}${reset}`;

function hasSubTitle(ext) {
  return ext?.some((r) => extSubt.has(r) || extDisk.has(r));
}
function hasCover(ext) {
  return ext?.some((r) => extCover.has(r) || extDisk.has(r));
}
function videoExt(ext) {
  return ext
    ?.filter((value) => extVideo.has(value) || extDisk.has(value))
    .toString()
    .padEnd(3);
}
function isAMovie(ext) {
  return extVideo.has(ext.replace(/^\./, '').toLowerCase());
}
function isAnEBook(ext) {
  return extEBook.has(ext.replace(/^\./, '').toLowerCase());
}

// running tmdb requests
const runningRequests = new Map();

async function fetchJSON(url) {
  // Direct in cache => return cached result
  if (tmdb.cache.has(url)) {
    write.output(`   ******${url} (cached)`);
    return tmdb.cache.get(url);
  }

  // If a request for this URL is already running, return the existing Promise
  if (runningRequests.has(url)) {
    write.output(`   ******${url} (already running)`);
    return runningRequests.get(url);
  }

  // else, start a new request as a Promise and store it in the Map
  const requestPromise = fetch(url, { signal: AbortSignal.timeout(10_000) })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      if (json !== null) tmdb.cache.set(url, json);
      return json;
    })
    .catch((e) => {
      console.error('Fetching error', url, e.message);
      return null;
    })
    .finally(() => {
      runningRequests.delete(url);
    });

  // save the Promise in the Map so that subsequent calls can use it
  runningRequests.set(url, requestPromise);

  write.output(`   ******${url}`);
  return requestPromise;
}

function translateLang(l, title = '') {
  if (title.includes('English')) return 'en';
  if (title.includes('French')) return 'fr';
  if (l === undefined) return '--';
  if (l.length === 2) return l;
  const mapped = LANG_MAP.get(l);
  if (mapped) return mapped;
  write.output(`!!!!!!!!!!!! translateLang error : <${l}|${title}>`);
  return l;
}

const ILLEGAL_CHARS = new Map([
  [':', '\u2236'], // replace : by ꞉
  ['?', '\uFF1F'], // replace ? by ？
  ['*', '\uFF0A'], // replace * by ＊
  ['/', '\u2215'], // replace / by ∕
  ['<', '\uFF1C'], // replace < by ＜
  ['>', '\uFF1E'], // replace > by ＞
]);
const reIllegalChars = new RegExp(`[${[...ILLEGAL_CHARS.keys()].map((c) => `\\${c}`).join('')}]`, 'g');

function movieStyleInternal(title) {
  if (!title) return '##notitle##';
  const words = title
    .trim() // https://stackoverflow.com/questions/1976007/what-characters-are-forbidden-in-windows-and-linux-directory-names
    .replace(reIllegalChars, (c) => ILLEGAL_CHARS.get(c)) // replace illegal chars by unicode equivalent
    .split(' ');
  return words
    .map((w) => {
      if (prepSet.has(w)) return w;
      if (w.length > 2 && (w[1] === "'" || w[1] === '’')) {
        return w.slice(0, 2) + w.charAt(2).toUpperCase() + w.slice(3);
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

const movieStyle = (titles) => Object.fromEntries(Object.entries(titles).map(([key, value]) => [key, movieStyleInternal(value)]));

const HOW_MANY = 40;
const genData = (len, size) => Array.from({ length: len }, () => ({ fullname: '', size }));
const biggest = Object.fromEntries(['4K', '1080p', 'SD'].map((res) => [res, genData(HOW_MANY, 0)]));
const smallest = genData(HOW_MANY, Number.MAX_VALUE);
const duplicates = new Map();

const fillBiggest = (fullname, size) => {
  Object.entries(biggest).forEach(([res, list]) => {
    if (fullname.includes(res) && size > list[0].size) {
      list.push({ fullname, size });
      list.sort((a, b) => a.size - b.size);
      list.shift();
    }
  });
};

const fillSmallest = (fullname, ext, size) => {
  if (isAMovie(ext) && size < smallest[smallest.length - 1].size) {
    smallest.push({ fullname, size });
    smallest.sort((a, b) => a.size - b.size);
    smallest.pop();
  }
};

const timelapse = Array.from({ length: 200 }, () => ({ fullname: '', mtime: new Date() }));
const fillTimelapse = (fullname, mtime) => {
  if (mtime === undefined) return;
  if (mtime < timelapse[0].mtime) {
    timelapse.push({ fullname, mtime });
    timelapse.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    timelapse.shift();
  }
};

const oldest = new Map();
const fillOldest = (fullname, category, mtime) => {
  if (mtime === undefined) return;
  if (!oldest.has(category)) oldest.set(category, { fullname, mtime });
  else if (mtime < oldest.get(category).mtime) {
    oldest.set(category, { fullname, mtime });
  }
};

function appendVideos(videos, category, movie, fullname, ext, seen, size, mtime) {
  if (!videos.has(category)) videos.set(category, new Map());

  if (!seen) {
    fillBiggest(fullname, size);
    fillSmallest(fullname, ext, size);
    if (isAMovie(ext)) {
      fillTimelapse(fullname, mtime);
      fillOldest(fullname, category, mtime);
    }
  }

  let mov = reLangSubExtEnd.test(movie) ? movie.slice(0, -4) : movie;
  mov = mov.endsWith('.forced') ? mov.slice(0, -7) : mov;
  mov = mov.endsWith('.sdh') ? mov.slice(0, -4) : mov;

  const categoryMap = videos.get(category);
  if (!categoryMap.has(mov)) {
    categoryMap.set(mov, new Map(Object.entries({ fullname, extension: [ext], seen, size, mtime })));
  } else {
    //if (isAMovie(ext)) Object.assign(categoryMap.get(mov).set('fullname', fullname).set('size', size).set('mtime', mtime));
    const entry = categoryMap.get(mov);
    if (isAMovie(ext)) {
      entry.set('fullname', fullname).set('size', size).set('mtime', mtime);
    }
    entry.get('extension').push(ext);
  }
}

function appendToCollection(movieName, movieDate, movieSize, movieSeen, movieEntry, location, isSerie) {
  Object.entries(collectionactors).forEach(([actor, v]) => {
    if (movieName.includes(actor) || location.includes(actor)) v.push({ movieName, movieDate, movieSeen, movie: movieEntry, location });
  });

  plainlist.push({ movieName, movieDate, movieSeen, movie: movieEntry, location });
  if (movieName.includes('] 4K ') && !movieSeen) fourklist.push({ movieName, movieDate, movieSize, movieSeen, movie: movieEntry, location });

  if (isSerie) return;
  if (movieName.includes('[extra')) return;

  const titleYear = movieName.match(reTitleYear);
  if (titleYear === null) return;
  const { title, titleVO, year } = titleYear.groups;
  const duplicateLine = movieEntry; // `${location}\\${movieName}`
  if (!duplicateExceptionsSet.has(title)) {
    const titleY = `${title}${year}@${movieSeen}`;
    if (!duplicates.has(titleY)) duplicates.set(titleY, [duplicateLine]);
    else duplicates.get(titleY).push(duplicateLine);
  }

  if (titleVO.length > 0 && titleVO !== title && !duplicateExceptionsSet.has(titleVO)) {
    const titleVOY = titleVO + year;
    if (!duplicates.has(titleVOY)) duplicates.set(titleVOY, [duplicateLine]);
    else duplicates.get(titleVOY).push(duplicateLine);
  }
}

async function* walk(dir) {
  try {
    for await (const d of await fs.opendir(dir)) {
      const entry = join(dir, d.name);
      if (d.isDirectory()) {
        if (!excludedFoldersSet.has(d.name)) yield* walk(entry);
      } else if (d.isFile()) yield entry;
    }
  } catch (err) {
    write.output(err.message);
    return;
  }
}

async function walkAsync(d) {
  const fileOrPath = await fs.stat(d);
  if (fileOrPath.isDirectory()) {
    const files = await fs.readdir(d);
    return Promise.all(files.map((f) => walkAsync(join(d, f))));
  }
  return { d, size: fileOrPath.size };
}

async function removeThumbs(file) {
  const thumbs = file.replace(PATH_RO, PATH_RW);
  write.output(`Deleting ${thumbs}`);
  await fs.unlink(thumbs);
}

async function collectVideoFromPaths(videos) {
  return Promise.all(
    videoPaths.map(async (folder) => {
      try {
        //// write.output(`Reading async ${folder.path}`);
        const stats = await fs.stat(folder.path);
        if (!stats.isDirectory()) return;

        for await (const file of walk(folder.path)) {
          const { dir, name, ext } = parse(file);
          if (name === 'Thumbs' && ext === '.db') {
            await removeThumbs(file);
          } else {
            const category = dir.split(sep).pop();
            const { size, mtime } = await fs.stat(file);
            appendVideos(videos, category, name, file, ext.substring(1), folder.seen, size, mtime);
          }
        }
      } catch (err) {
        write.output(`Reading ${folder.path} (NOT FOUND)`, err);
      }
    }),
  ).then(() => videos);
}

async function collectVideoFromDisks(videos) {
  return Promise.all(
    videoDisks.map(async (disk) => {
      write.output(`Reading async ${disk.path}`);
      // createInterface returns an async iterable, so we can use for await...of to read lines one by one
      const rl = createInterface({ input: createReadStream(disk.path), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.length) continue;
        const parsed = parse(line);
        const category = parsed.dir.split(sep).pop();
        appendVideos(videos, category, parsed.name, line, parsed.ext.substring(1), disk.seen, undefined);
      }
      //// write.output(`Done reading async ${disk.path}`);
    }),
  ).then(() => videos);
}

async function readFromJsonArchive(videos, jsonFile) {
  //// write.output(`Reading async ${jsonFile}`);
  const json = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  for (const [category, movies] of Object.entries(json))
    for (const [name, details] of Object.entries(movies))
      for (const ext of Object.values(details.extension)) appendVideos(videos, category, name, details.fullname, ext, true, details.size, undefined);
  //// write.output(`Done reading async ${jsonFile}`);
}

async function writeToJsonArchive(jsonMap, jsonFile) {
  // convert Map to json
  const json = Object.create(null);

  for (const [category, movieListMap] of jsonMap) {
    json[category] = Object.create(null);
    for (const [movie, movieEntries] of movieListMap) {
      json[category][movie] = Object.fromEntries(movieEntries);
    }
  }
  // write the json
  await fs.writeFile(jsonFile, JSON.stringify(json, null, 3), { mode: 0o755 });
}

async function readFromMetaCache(metaCache) {
  const mpFile = process.env.METACACHE_PATH_MP;
  try {
    const compressed = await fs.readFile(`${mpFile}.gz`);
    const buffer = await promisify(gunzip)(compressed);
    const json = decode(buffer);
    Object.entries(json).forEach(([fullname, meta]) => metaCache.set(fullname, meta));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    write.output('No metacache found, starting fresh');
  }
}

async function writeToMetaCache(metaCache) {
  const mpFile = process.env.METACACHE_PATH_MP;

  // Backup old version
  try {
    await fs.copyFile(`${mpFile}.gz`, `${mpFile}.gz.bak`);
  } catch (err) {
    console.error(err);
    if (err.code !== 'ENOENT') throw err; // ignore if no previous version
  }

  const compressed = await promisify(gzip)(encode(Object.fromEntries(metaCache)));
  await fs.writeFile(`${mpFile}.gz`, compressed, { mode: 0o755 });
}

async function readFromDiskArchive(videos, folder) {
  const json = new Map();
  const stats = await fs.stat(folder);
  write.output(`Reading ${folder}`);
  if (stats.isDirectory()) {
    const files = (await walkAsync(folder)).flat(Infinity);
    files.forEach(({ d: file, size }) => {
      const parsed = parse(file);
      const category = parsed.dir.split(sep).pop();
      appendVideos(videos, category, parsed.name, file, parsed.ext.substring(1), true, size);
      appendVideos(json, category, parsed.name, file, parsed.ext.substring(1), true, size);
    });
  }
  return json;
}

function cleanTitle(title) {
  console.log(`Cleaning title: ${title}`);
  console.log(`Using cleanReplacements: ${cleanReplacements}`);
  console.log(cleanReplacements.reduce((str, term) => str.replaceAll(term, ''), title));
  return cleanReplacements
    .reduce((str, term) => str.replaceAll(term, ''), title)
    .replaceAll(/Ã./g, (match) => String.fromCharCode(match.charCodeAt(1) + 64)) // https://www.i18nqa.com/debug/utf8-debug.html
    .replaceAll('&ccedil;', 'ç')
    .replaceAll('&eactute', 'é')
    .replaceAll('ГЁ', 'è')
    .replaceAll('Г©', 'é')
    .replace(/[._]+/g, ' ') // replace . and _ by space
    .replace(/\s{2,}/g, ' ') // trim internal multiple spaces to single space
    .trim();
}

function fixedEncodeURIComponent(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
}

async function generateSerie(isSerie, language, specs) {
  const { serieTitle, originalSerieTitle, season, episode, serieDate1, serieDate2, serieDate3 } = isSerie.groups;
  const encodedTitle = fixedEncodeURIComponent(originalSerieTitle || serieTitle);
  const tmdbserie = await fetchJSON(`${tmdb.base}/search/tv?${tmdb.key}&${tmdb.fr}&${tmdb.adult}&query=${encodedTitle}`);
  const serieDate = parseInt(serieDate1 || serieDate2 || serieDate3, 10);

  if (tmdbserie === null || tmdbserie.total_results === 0) {
    write.output(`    No result found for serie: ${originalSerieTitle || serieTitle}`);
    return NO_SUGGESTION;
  }
  let {
    results: [firstentry],
  } = tmdbserie;
  if (tmdbserie.total_results > 1 && serieDate) {
    tmdbserie.results.some((entry) => {
      if (Math.abs(new Date(entry.first_air_date).getFullYear() - serieDate) <= YEAR_TOLERANCE) {
        // tolerance of 1 year
        firstentry = entry;
        return true;
      }
      return false;
    });
  }
  // firstentry.id = 80605;
  const firstAirYear = new Date(firstentry.first_air_date).getFullYear();

  const [tmdbepisode, tmdbepisodeVO, tmdbepisodeCast, tmdbNbEpisode] = await Promise.all([
    fetchJSON(`${tmdb.base}/tv/${firstentry.id}/season/${season}/episode/${episode}?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`),
    fetchJSON(`${tmdb.base}/tv/${firstentry.id}/season/${season}/episode/${episode}?${tmdb.key}&${tmdb.adult}`),
    fetchJSON(`${tmdb.base}/tv/${firstentry.id}/season/${season}/episode/${episode}/credits?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`),
    fetchJSON(`${tmdb.base}/tv/${firstentry.id}?${tmdb.key}`),
  ]);

  if (!tmdbepisode) {
    write.output(`    No episode found for season : [${season}] episode : [${episode}]`);
    return NO_SUGGESTION;
  }

  const airYear = tmdbepisode.air_date ? new Date(tmdbepisode.air_date).getFullYear() : firstAirYear;
  const parenthesis = [airYear];
  const { title, VOtitle } = movieStyle({
    title: firstentry.name,
    VOtitle: firstentry.original_name,
  });
  if (title !== VOtitle) parenthesis.unshift(VOtitle);

  const company = [];
  tmdbNbEpisode?.production_companies?.forEach(({ name }) => {
    if (STUDIO_MAP.has(name)) company.push(STUDIO_MAP.get(name));
  });

  wellKnownActors.forEach((actor) => {
    const inCast = tmdbepisodeCast?.cast?.some((c) => c.name === actor);
    const inCrew = tmdbepisodeCast?.crew?.some((c) => c.name === actor);
    if (inCast || inCrew) company.push(actor);
  });

  if (company.join(', ').length !== 0) parenthesis.push(company.join(', '));

  const { title: episodeName, epVOtitle } = movieStyle({
    title: tmdbepisode.name,
    epVOtitle: tmdbepisodeVO.name,
  });
  const episodeVOName = epVOtitle === episodeName ? '' : ` (${epVOtitle})`;

  const NbEpisodeInSeason = tmdbNbEpisode?.seasons?.find((s) => s.season_number == season)?.episode_count ?? -1; // eslint-disable-line eqeqeq
  const isFinalEpisode = episode == NbEpisodeInSeason ? ' FINAL' : ''; // eslint-disable-line eqeqeq
  const suggestedName = `${title} (${parenthesis.join(' ')}) S${season.padStart(2, '0')}E${episode.padStart(2, '0')}${isFinalEpisode} - ${episodeName}${episodeVOName} - ${language} ${specs.toString()}`;
  write.output(`         ${suggestedName}`);
  return { suggestedName, id: firstentry.id };
}

function LookForDefaultLang(title) {
  if (reLookFrench.test(title)) {
    write.output('   default language looks FR');
    return 'FR';
  }
  if (reLookMulti.test(title)) {
    write.output('   default language looks MULTi');
    return 'MULTi';
  }
  return undefined;
}

function generateLanguage(specs, subtitle, defaultLang = 'VO') {
  const audios = specs.toAudioString();
  const nbAudio = audios.length;

  if (nbAudio === 0) return 'NOSOUND';

  // Group audio tracks by language
  const grouped = Object.groupBy(audios, (as) => as.language ?? 'undefined');
  const getLen = (lang) => grouped[lang]?.length ?? 0;

  const audioFrench = getLen('fr');
  const audioNonFrench = nbAudio - audioFrench;

  // Priority: if all audio tracks are French, return 'FR'; if there's a mix of French and non-French, return 'MULTi'
  if (audioFrench === nbAudio) return 'FR';
  if (audioFrench > 0 && audioNonFrench > 0) return 'MULTi';

  // If there's only one language present (one or more time),
  // use the LANG_CODE_MAP to determine the language code
  const singleLangEntry = Object.entries(grouped).find(([, arr]) => arr.length === nbAudio);

  let language;
  if (singleLangEntry && LANG_CODE_MAP[singleLangEntry[0]] !== undefined) {
    language = LANG_CODE_MAP[singleLangEntry[0]];
  } else {
    // Fallback si langue inconnue dans la map
    write.output(audios[0].language);
    language = defaultLang;
  }

  // Gestion des sous-titres
  if (audioFrench === 0 && audioNonFrench > 0) {
    if (subtitle.includes('fr')) language += 'STFR';
    else if (subtitle.includes('en')) language += 'ST';
  }

  return language;
}

async function generateKnownCompanyCast(id, comp) {
  const knownCompany = new Set(); // don't want duplicate e.g. Woody Allen

  comp.forEach(({ name }) => {
    if (STUDIO_MAP.has(name)) knownCompany.add(STUDIO_MAP.get(name));
  });

  const tmdbcast = await fetchJSON(`${tmdb.base}/movie/${id}/casts?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`);

  const directors = (tmdbcast?.crew || []).filter((c) => c.job === 'Director');
  await Promise.all(
    directors.map(async (crew) => {
      const tmdbpeople = await fetchJSON(`${tmdb.base}/person/${crew.id}?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`);
      write.output(`   🎬 ${crew.name} (${tmdbpeople?.place_of_birth ?? 'Unknown'}) 🎬`);
    }),
  );

  wellKnownDirectors.forEach((crew) => {
    if (tmdbcast?.crew?.some((c) => c.name === crew)) knownCompany.add(crew);
  });
  wellKnownActors.forEach((actor) => {
    if (tmdbcast?.cast?.some((c) => c.name === actor)) knownCompany.add(actor);
  });
  return [...knownCompany].join(', ');
}

function generateCountry(countries) {
  return countries.map((c) => c.iso_3166_1.replace('GB', 'UK').toLowerCase()).join(' ');
}

function generateGenres(genreIds) {
  return genreIds.map((g) => tmdb.genre[g]).join(' ');
}

async function generateMovie(isMovie, language, specs) {
  const { frontYear, frenchTitle, voTitle, voTitle2 } = isMovie.groups;
  let lang = language;

  let { year = frontYear } = isMovie.groups;
  if (year >= 90 && year <= 99) year = `19${parseInt(year, 10)}`;

  let tmdbody;
  let encodedTitle = (voTitle || voTitle2 || frenchTitle).split(/ aka /i);
  encodedTitle = encodedTitle.map((t) => fixedEncodeURIComponent(t.trim()));

  const tmdbSearchUrl = (query, year) => `${tmdb.base}/search/movie?${tmdb.key}&${tmdb.fr}&${tmdb.adult}&query=${query}${year ? `&year=${year}` : ''}`;

  //tmdbody = await fetchJSON(tmdbSearchUrl(encodedTitle[0], year));

  if (year) {
    tmdbody = await fetchJSON(tmdbSearchUrl(encodedTitle[0], year));
    if (encodedTitle.length > 1 && tmdbody.total_results === 0) {
      // second aka
      tmdbody = await fetchJSON(tmdbSearchUrl(encodedTitle[1], year));
    }
  }
  if (!year || tmdbody === null || tmdbody.total_results === 0) {
    tmdbody = await fetchJSON(tmdbSearchUrl(encodedTitle[0], null));
    if (encodedTitle.length > 1 && tmdbody.total_results === 0) {
      // second aka
      tmdbody = await fetchJSON(tmdbSearchUrl(encodedTitle[1], null));
    }
    if (tmdbody === null || tmdbody.total_results === 0) return write.output('Not found on TMDB');
    year = new Date(tmdbody.results[0].release_date).getFullYear() || year;
  }

  let {
    results: [firstentry],
  } = tmdbody;
  if (tmdbody.total_results > 1 && year) {
    tmdbody.results.some((entry) => {
      if (Math.abs(new Date(entry.release_date).getFullYear() - parseInt(year, 10)) <= 1) {
        // tolerance of 1 year
        firstentry = entry;
        return true;
      }
      return false;
    });
  }
  const firstresult = await generationForEntry(firstentry);
  // const secondresult = await generationForEntry(secondentry);
  return firstresult;

  async function generationForEntry(entry) {
    if (entry === undefined) return;

    const { id, genre_ids: genreIDs, adult } = entry;
    let { title, original_title: VOtitle } = entry;

    const tmddetail = await fetchJSON(`${tmdb.base}/movie/${id}?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`);
    const country = generateCountry(tmddetail.production_countries);
    const finalGenreIds = adult ? [...genreIDs, 'xxx'] : genreIDs;
    const genres = generateGenres(finalGenreIds);
    const knownCompanies = await generateKnownCompanyCast(id, tmddetail.production_companies);
    if (country === 'fr' && lang === 'VO' && tmddetail.original_language === 'fr') {
      lang = 'FR';
    }

    ({ title, original_title: VOtitle } = movieStyle({
      title,
      original_title: VOtitle,
    }));

    const parenthesis = VOtitle !== title ? [VOtitle] : [];
    parenthesis.push(year);
    if (knownCompanies.length > 0) parenthesis.push(knownCompanies);

    const suggestedName = `${title} (${parenthesis.join(' ')}) - ${lang} [${genres} ${country}] ${specs.toString()}`;
    write.output(`   ******${suggestedName}`);
    return { suggestedName, id };
  }
}

async function generateSuggestion(dirtytitle, specs, subtitle) {
  const t = cleanTitle(dirtytitle);

  write.output(`   ******${t}`);
  const isMovie = t.match(
    /^(?<frontYear>((?:19|20)\d\d)|9\d)? ?((?<frenchTitle>[^(]+)\s*(\s*\(\s*(?<voTitle>.*?))*\s*(?<year>((?:19|20)\d\d)| 9\d).*|(?:(?!(19|20)\d\d)(?<voTitle2>.*)))/,
  );
  const isSerie = t.match(
    /(?<serieTitle>.*?)\s*(?<serieDate1>(?:19|20)\d\d)?(?:\((?<originalSerieTitle>.*?)(?<serieDate2>(?:19|20)\d\d)?\))?\s*(?:S|saison )?(?<season>\d?\d) ?(?:x| x |E|xE|Ep| émission )(?<episode>\d?\d?\d)(.*(?<serieDate3>(?:19|20)\d\d)+|.*)/i,
  );

  if (!isMovie && !isSerie) return NO_SUGGESTION;

  const defaultLang = LookForDefaultLang(dirtytitle);
  const language = generateLanguage(specs, subtitle, defaultLang);

  return isSerie ? generateSerie(isSerie, language, specs) : generateMovie(isMovie, language, specs);
}

async function collectVideoFromArchive(videos) {
  return Promise.all(
    archiveDisks.map(async (archive) => {
      let folder = null;
      for (const drive of DRIVELETTERS) {
        if (await fileExists(`${drive}:\\${archive.path}`)) {
          folder = `${drive}:\\${archive.path}`;
          break;
        }
      }
      if (folder === null) {
        const jsonPath = join(documentRO, `${archive.path}.json`);
        return (await fileExists(jsonPath)) ? await readFromJsonArchive(videos, jsonPath) : write.output(`Reading ${archive.path}.json (NOT FOUND)`);
      }
      try {
        const json = await readFromDiskArchive(videos, folder);
        const jsonPathRW = join(documentRW, `${archive.path}.json`);
        await writeToJsonArchive(json, jsonPathRW);
      } catch (err) {
        write.output(err);
        write.output(`Reading ${folder} (NOT FOUND)`);
      }
      return null;
    }),
  ).then(() => videos);
}

function showSpecs(title, specs, subt) {
  if (!title.endsWith(specs.toString())) write.output(`   ******${specs.toString()}`);
  if (subt.length > 0) write.output(`   Sub: ${subt.join('/')}`);
}

async function showVideoInfo(title, fullname) {
  // write.output(movie);
  const currentExt = fullname.split('.').pop();
  if (!isAMovie(currentExt)) return NO_SUGGESTION;

  write.output(fullname);

  if (noSuggestion.test(fullname)) return NO_SUGGESTION;

  if (!(await fileExists(fullname))) return NO_SUGGESTION; // case json

  try {
    const { stdout } = await execFileAsync(mediainfo, [fullname, '--Output=JSON']);
    const json = JSON.parse(stdout).media;

    const specs = new MovieSpecs();

    const subt = [];
    Object.values(json.track).forEach((track) => {
      switch (track['@type']) {
        case 'Video':
          specs.videoSize(track);
          if (track.Title) write.output(`   Track Title : ${track.Title}${track.Title.length}`);
          break;
        case 'Audio':
          specs.audioFormat(
            track.ID,
            translateLang(track.Language, track.Title),
            track.CodecID || track.Format,
            track.Channels_Original || track.Channels,
            track.Format_AdditionalFeatures,
          );
          break;
        case 'Text':
          subt.push(translateLang(track.Language, track.Title));
          break;
        case 'General':
        case 'Menu':
        case 'Other':
          break;
        default:
          write.output(`unknown track ${track['@type']}`);
          write.output(track);
      }
    });
    showSpecs(title, specs, subt);

    return await generateSuggestion(title, specs, subt);
  } catch (e) {
    write.output('JSON parsing error', e);
    throw e;
  }
}

async function malformed(movieKey, fullname, counter) {
  if (!skipPhysical || !reExceptions.test(fullname)) {
    counter.bad++;
    write.output(`${counter.bad} >>> ${fullname}`);
    return showVideoInfo(movieKey, fullname);
  }
  return NO_SUGGESTION;
}

function formatSize(size) {
  let s = size;
  if (s === undefined) return '        ';
  if (s < 1000) return `${s.toString().padStart(5)}  B`;

  for (const prefix of 'KMGTPEZY') {
    s /= 1024;

    if (s < 9.995) return ` ${s.toFixed(2)} ${prefix}B`;
    if (s < 99.995) return `${s.toFixed(2)} ${prefix}B`;
    if (s < 999.95) return `${s.toFixed(1)} ${prefix}B`;
  }
  return `${s.toFixed(1)} YB`; // should never happen
}

const createCounter = () => ({
  bad: 0,
  badmeta: 0, // title or video track should not be set
  noCover: 0, // number of missing cover
  seen: 0, // number of movies seen
  movie: 0, // total number of movies
  serie: 0, // total number of series
  serie_seen: 0, // total number of serie episodes seen
  tera: 0, // how many terabyte ?
});

function setSizeTo(str, size) {
  if (str.length > size) return `${str.slice(0, size - 3)}...`;
  return str.padEnd(size);
}

async function readMediaInfo(fullname, metaCache) {
  if (metaCache.has(fullname)) return metaCache.get(fullname);

  try {
    // const child = spawnSync(`${mediainfo}`, [`${fullname}`, '-f', '--Output=JSON']);
    const { stdout } = await execFileAsync(mediainfo, [fullname, '-f', '--Output=JSON']);
    const json = JSON.parse(stdout).media;
    metaCache.set(fullname, json);
    return json;
  } catch (e) {
    console.log(e);
    return undefined;
  }
}

async function checkVideoTags(fullname, counter, metaCache) {
  const json = await readMediaInfo(fullname, metaCache);
  if (!json) return;

  Object.values(json.track).forEach((track) => {
    if (track['@type'] === 'General' && track.Title !== undefined) {
      write.output(color(BGred)`${counter.movie} ${setSizeTo(fullname, 200)}   Track(General) : ${track.Title}`);
      metaCache.delete(fullname);
      counter.badmeta++;
    }

    if (track['@type'] === 'Video' && track.Title !== undefined) {
      // execption for video title (dual video)
      if (videoTagExceptions.some((e) => fullname.includes(e))) return;
      write.output(`${counter.movie} ${setSizeTo(fullname, 200)}   Track(Video) : ${track.Title}`);
      metaCache.delete(fullname);
      counter.badmeta++;
    }
  });
}

async function displayWellFormed(movieKey, movieEntry, { groups }, counter, metaCache) {
  const fullname = movieEntry.get('fullname');
  const extension = movieEntry.get('extension');
  const seen = movieEntry.get('seen');
  const size = movieEntry.get('size');
  const isSerie = regIsSerie.test(fullname);

  if (seen) counter.seen++;
  counter.movie++;
  if (isSerie) counter.serie++;
  if (seen && isSerie) counter.serie_seen++;
  counter.tera += size ?? 0;
  const movieType = videoExt(extension).slice(0, 3);
  const movieDate = groups.date ?? '____';
  const movieQuality = groups.quality ?? groups.quality2 ?? '?';
  //const location = fullname.replace(/(.*)\\(.*)/, '$1');
  const location = parse(fullname).dir;

  if (extension.includes('mkv')) {
    // || extension.includes('mp4')) { // && location.startsWith('E:\\')) {
    await checkVideoTags(fullname, counter, metaCache);
  }
  const metaInfo = metaCache.get(fullname);
  const duration = metaInfo?.track.find((t) => t['@type'] === 'General')?.Duration_String ?? '?';
  const encoding = metaInfo?.track.find((t) => t['@type'] === 'Video')?.Format_String;
  const encodingLabel = encoding ? ` (${ENCODING_TABLE[encoding] ?? encoding})` : '';
  const quality = `${movieQuality}${encodingLabel}`;
  const movieLine = `│${movieType}│${movieDate}│${hasSubTitle(extension) ? 'S' : ' '}│${seen ? '@@' : '  '}│${formatSize(size)}│ ${setSizeTo(quality, 15)}│ ${setSizeTo(duration, 11)}│ ${setSizeTo(movieKey, 160)}${location}`;
  appendToCollection(movieKey, movieDate, size, seen, movieLine, location, isSerie);
  write.list(movieLine);
}

async function printTMDBdetails(movieId, counter) {
  counter.noCover++;

  const results = await Promise.allSettled([
    fetchJSON(`${tmdb.base}/movie/${movieId}?${tmdb.key}&${tmdb.fr}&${tmdb.adult}`),
    fetchJSON(`${tmdb.base}/movie/${movieId}?${tmdb.key}`),
  ]);
  const tmdbDetailFR = results[0].status === 'fulfilled' ? results[0].value : null;
  const tmdbDetailVO = results[1].status === 'fulfilled' ? results[1].value : null;

  if (!tmdbDetailFR) {
    write.output('    no valid tmdb detail for image');
    return;
  }
  const frposter = tmdbDetailFR.poster_path;
  if (frposter) write.output(`    ${tmdb.image}${frposter}`);
  else write.output('    no image in tmdb for this movie in french');

  if (!tmdbDetailVO) {
    write.output('    no valid tmdb detail for image');
    return;
  }
  const voposter = tmdbDetailVO.poster_path;
  if (voposter !== frposter) write.output(`    ${tmdb.image}${voposter}`);
  else write.output('    no image in tmdb for this movie in vo');
}

const reSkipSubtitle = /(\.sdh|\.forced)?\.(eng|fre|dut|ger)\.(srt|ass)$/;

async function findCovers(movieKey, fullname, counter, id) {
  if (skipCover) return;
  if (!skipPhysical) return;
  if (reExceptions.test(fullname)) return;
  if (reSerie.test(fullname)) return;
  if (reSkipSubtitle.test(fullname)) return; // skip .eng.srt & .fre.srt

  if (id !== undefined) return await printTMDBdetails(id, counter); // direct access to cover

  write.output('No cover', counter.noCover, fullname);
  let friendname = movieKey.match(/^(.*\(.*?\d\d\d\d)/)[1]; // .*? === lazy
  friendname = fixedEncodeURIComponent(friendname);
  write.output(`   https://duckduckgo.com/?q=senscritique+${friendname}&ia=images&iax=images&&kp=-2&iaf=size%3ALarge`);
  const titleYear = movieKey.match(/(\((v|\d*)\) )?(?<title>.*)\((?<titleVO>.*?)\s?(?<year>(?:19|20)\d\d).*/);
  if (titleYear === null) return;
  const { title, titleVO, year } = titleYear.groups;
  const encodedTitle = fixedEncodeURIComponent((titleVO || title).trim());
  const tmdbody = await fetchJSON(`${tmdb.base}/search/movie?${tmdb.key}&${tmdb.fr}&${tmdb.adult}&year=${year}&query=${encodedTitle}`);
  try {
    const {
      results: [firstentry], //secondentry],
    } = tmdbody;
    await printTMDBdetails(firstentry.id, counter);
  } catch {
    // empty catch
  }
}

async function checkVideos(videos, metaCache) {
  const counter = createCounter();
  const collator = new Intl.Collator();
  const [, , strMax, ...args] = process.argv;
  const max = strMax !== undefined ? Number(strMax) : Infinity;
  // escape everything non [^a-zA-Z0-9_]
  const argsRE = args.length > 0 ? new RegExp(args.join(' ').replace(/(\W)/g, '\\$1'), 'i') : /.*/;

  for (const [category, moviesList] of videos) {
    write.list(`\r\n========= ${category} =========`);

    const sortedMovies = [...moviesList].sort(collator.compare);

    for (const [movieKey, movieEntry] of sortedMovies) {
      const isWellFormed = movieKey.match(reAll);

      if (isWellFormed === null && counter.bad < max && argsRE.test(movieEntry.get('fullname'))) {
        //        if (isWellFormed === null || (counter.bad < max && argsRE.test(movieEntry.get('fullname')))) {
        const { suggestedName, id } = (await malformed(movieKey, movieEntry.get('fullname'), counter)) || {};

        if (suggestedName !== undefined) {
          await findCovers(suggestedName, suggestedName, counter, id);
        }
      } else {
        await displayWellFormed(movieKey, movieEntry, isWellFormed, counter, metaCache);
        if (!hasCover(movieEntry.get('extension'))) {
          await findCovers(movieKey, movieEntry.get('fullname'), counter);
        }
      }
    }
  }
  return counter;
}

const dateOrder = (a, b) => {
  if (a.movieDate === b.movieDate) return a.movieName.localeCompare(b.movieName);
  if (a.movieDate === '____') return 1;
  if (b.movieDate === '____') return -1;
  return a.movieDate - b.movieDate;
};

// const box = (s, ...v) => {
//   const msg = v.reduce((acc, val, i) => acc + val + s[i + 1], s[0]);
//   const line = '─'.repeat(msg.length);
//   return `┌─${line}─┐\r\n│ ${msg} │\r\n└─${line}─┘`;
// };
const box = (s, ...v) => {
  const msg = String.raw({ raw: s }, ...v);
  const line = '─'.repeat(msg.length);
  return `┌─${line}─┐\r\n│ ${msg} │\r\n└─${line}─┘`;
};

const reDisneyNumber = /^\d{3} /;
const reDisney = /disney/;

function movieSort(a, b) {
  const first = reDisneyNumber.test(a.movieName) && reDisney.test(a.location) ? a.movieName.substring(4) : a.movieName;
  const second = reDisneyNumber.test(b.movieName) && reDisney.test(b.location) ? b.movieName.substring(4) : b.movieName;
  return first.localeCompare(second);
}

function timeSort(a, b) {
  return a.movieDate.localeCompare(b.movieDate);
}

function sizeSort(a, b) {
  return b.movieSize - a.movieSize;
}

async function removeEmptyFolders(folder) {
  for await (const d of await fs.opendir(folder)) {
    // slint-disable-line no-restricted-syntax
    const entry = join(folder, d.name);
    if (d.isDirectory()) {
      const contents = await fs.readdir(entry);
      if (contents.length > 0) await removeEmptyFolders(entry);
      else
        try {
          await fs.rmdir(entry);
          write.output(`Folder deleted: ${entry}`);
        } catch (err) {
          if (err.code === 'ENOTEMPTY') write.output(`Folder not empty: ${entry}`);
          else write.output(`Error delete ${err}`);
        }
    }
  }
}

async function renameByCopy(file, target) {
  await fs
    .copyFile(file, target)
    .then(() => fs.unlink(file))
    .catch((err) => write.output(`Error moving file ${err}`));
}

async function moveNewFiles() {
  for (const currentPath of downloadPaths) {
    for await (const file of walk(currentPath)) {
      const { name, ext } = parse(file);
      let target;
      if (isAMovie(ext)) {
        target = join(targetVideoPath, `${name}${ext}`);
        write.output(`Moving new files ${file}\n              to ${target}`);
        await fs.rename(file, target).catch(async (err) => {
          if (err.code === 'EXDEV')
            // Cross-device link : fallback vers copy + unlink
            await renameByCopy(file, target);
          else write.output(`Error moving file ${err}`);
        });
      } else if (isAnEBook(ext)) {
        target = join(targetEBookPath, `${name}${ext}`);
        write.output(`Moving ebook ${file}\n          to ${target}`);
        await renameByCopy(file, target);
      }
    }
    await removeEmptyFolders(currentPath);
  }
}

function generateReports() {
  // 1. Biggest and smallest files

  Object.entries(biggest).forEach(([res, list]) => {
    write.collactor(box`The ${list.length} biggest ${res} (${formatSize(list.reduce((a, b) => a + b.size, 0)).trimStart()})`);
    list.toReversed().forEach(({ fullname, size }) => write.collactor(`${formatSize(size)} | ${fullname}`));
  });

  write.collactor(box`The ${smallest.length} smallest (${formatSize(smallest.reduce((a, b) => a + b.size, 0))})`);
  smallest.forEach(({ fullname, size }) => write.collactor(`${formatSize(size)} | ${fullname}`));

  // 2. Timelapse history
  timelapse.toReversed().forEach(({ fullname, mtime }) => write.timelapse(`${mtime.toLocaleDateString()} | ${fullname}`));

  // 3. Movies by favorite actors / directors
  Object.entries(collectionactors).forEach(([actor, v]) => {
    const sorted = [...v].sort(dateOrder);
    const vu = sorted.reduce((n, v2) => n + (v2.movieSeen ? 1 : 0), 0);
    write.collactor(box`${actor} (${((vu * 100) / sorted.length).toFixed(1)}% ${vu}/${sorted.length})`);
    sorted.forEach((v2) => write.collactor(v2.movie));
  });

  // 4. Complete list of movies sorted by name
  plainlist.toSorted(movieSort).forEach((v) => {
    write.plainlist(v.movie);
  });

  // 5. List of oldest movies for each category
  [...oldest.entries()]
    .sort(([, a], [, b]) => a.mtime - b.mtime)
    .forEach(([category, { mtime, fullname }]) => {
      write.oldest(box`${category}`);
      write.oldest(`${mtime.toLocaleDateString()} | ${fullname}`);
    });

  // 6. List of top 4K movies sorted by size
  Object.values(fourklist)
    .sort(sizeSort)
    .forEach((v) => {
      write.fourk(v.movie);
    });

  // 7. List of movies sorted by added time (oldest first)
  plainlist
    .filter((v) => !v.movieSeen)
    .sort(timeSort)
    .forEach((v) => {
      write.timesort(v.movie);
    });
}

function printFinalStats(counter, metaCacheSize, startDate) {
  // 1. Duplicates
  let duplicateCount = 1;
  duplicates.forEach((instance) => {
    if (instance.length > 1) {
      duplicateCount += 1;
      let brace = '┌─';
      instance.forEach((i) => {
        write.duplicate(`${brace} ${i}`);
        brace = '│ ';
      });
      write.duplicate('└─');
    }
  });
  write.duplicate(`${duplicateCount}`);

  // 2. Metrics calculation
  const totalSec = Math.round((performance.now() - startDate) / 1000);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const percViewed = Math.floor((counter.seen * 100) / counter.movie);
  const unseen = counter.movie - counter.seen;
  const percNotViewed = Math.ceil((unseen * 100) / counter.movie);

  // 3. Affichage du bilan dans output
  write.output(box`Total of ${counter.movie} media (${counter.movie - counter.serie}/${counter.serie} movies/episodes) (${formatSize(counter.tera)})`);
  write.output(box`${counter.seen} media (${counter.seen - counter.serie_seen}/${counter.serie_seen} movies/episodes) seen (${percViewed}%)`);
  write.output(
    box`${unseen} media (${unseen - counter.serie + counter.serie_seen}/${counter.serie - counter.serie_seen} movies/episodes) unseen (${percNotViewed}%)`,
  );

  write.output(`${counter.badmeta} bad meta data (${metaCacheSize} entries cached)`);

  if (counter.bad === 0) write.output(`perfect ! (checked in ${fmt.format({ minutes, seconds })})`);
  else write.output(`${counter.bad} bad${plural(counter.bad)} checked in ${fmt.format({ minutes, seconds })}`);
  if (counter.noCover > 0) write.output(`${counter.noCover} missing cover`);

  write.output(`${duplicateCount} duplicate${plural(duplicateCount)}`);

  const defects = counter.bad + counter.badmeta + counter.noCover;
  if (defects > 0) {
    write.output(box`${defects} defect${plural(defects)}`);
  }

  write.output(`${Math.ceil((counter.movie * (percViewed + 1)) / 100 - counter.seen)} movies to reach next ${percViewed + 1}%\n`);
}

async function main() {
  const startDate = performance.now();
  const videos = new Map();
  const metaCache = new Map();

  await moveNewFiles();

  await Promise.all([collectVideoFromPaths(videos), collectVideoFromDisks(videos), collectVideoFromArchive(videos), readFromMetaCache(metaCache)]);

  const counter = await checkVideos(videos, metaCache);

  await writeToMetaCache(metaCache);

  generateReports();

  printFinalStats(counter, metaCache.size, startDate);

  write.endAll();
  await write.renameTmpFiles();
}

// Start the main function and handle any uncaught errors
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
