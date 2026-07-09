import { createWriteStream } from 'fs';
import { join } from 'path';
import { format } from 'util';
import { rename } from 'node:fs/promises';

export class Writer {
  #files = {
    list: 'movie-list.txt',
    collactor: 'movie-collactor.txt',
    fourk: 'movie-4k.txt',
    timelapse: 'movie-timelapse.txt',
    oldest: 'movie-oldest.txt',
    timesort: 'movie-timesort.txt',
    duplicate: 'movie-duplicate.txt',
    plainlist: 'movie-plainlist.txt.tmp',
    output: 'movie-output.txt.tmp',
  };
  #streams = [];
  #baseDir;

  constructor(pathRO, pathRW) {
    this.#baseDir = join(pathRW, process.env.DOCUMENT_PATH || 'document');

    if (!pathRO || !pathRW || pathRO.length === 0 || pathRW.length === 0) {
      throw new Error('The pathRO and pathRW parameters must not be empty.');
    }
    for (const [key, fileName] of Object.entries(this.#files)) {
      const stream = createWriteStream(join(this.#baseDir, fileName), { flags: 'w' });
      this.#streams.push(stream);
      this[key] = (arg1 = '', ...args) => {
        const message = String(arg1).replace(pathRO, pathRW);
        const formatted = format('%s\n', message, ...args);
        if (stream.writable) stream.write(formatted);
        if (key === 'output') process.stdout.write(formatted);
      };
    }
  }

  #tmpPath(file) {
    return join(this.#baseDir, file);
  }

  async renameTmpFiles() {
    await Promise.all([
      rename(this.#tmpPath(this.#files.plainlist), this.#tmpPath(this.#files.plainlist.replace('.tmp', ''))),
      rename(this.#tmpPath(this.#files.output), this.#tmpPath(this.#files.output.replace('.tmp', ''))),
    ]);
  }

  endAll() {
    this.#streams.forEach((stream) => {
      if (stream.writable) stream.end();
    });
  }
}
