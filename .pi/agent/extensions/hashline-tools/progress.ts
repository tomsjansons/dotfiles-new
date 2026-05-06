import { writeFile } from "node:fs/promises";

export type WriteProgressPhase = "preparing" | "writing" | "done";

export type WriteProgress = {
	phase: WriteProgressPhase;
	writtenChars: number;
	totalChars: number;
	writtenLines: number;
	totalLines: number;
	writtenWords: number;
	totalWords: number;
};

const WRITE_CHUNK_SIZE = 64 * 1024;
const MIN_UPDATE_INTERVAL_MS = 50;

export function countTextLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length;
}

export function countTextWords(text: string): number {
	const words = text.match(/\S+/g);
	return words ? words.length : 0;
}

function countChunkWords(chunk: string, initiallyInsideWord: boolean): { words: number; insideWord: boolean } {
	let words = 0;
	let insideWord = initiallyInsideWord;
	for (const char of chunk) {
		if (/\s/.test(char)) {
			insideWord = false;
		} else if (!insideWord) {
			words++;
			insideWord = true;
		}
	}
	return { words, insideWord };
}

export function createInitialWriteProgress(content: string): WriteProgress {
	return {
		phase: "preparing",
		writtenChars: 0,
		totalChars: content.length,
		writtenLines: 0,
		totalLines: countTextLines(content),
		writtenWords: 0,
		totalWords: countTextWords(content),
	};
}

export function progressSummary(progress: WriteProgress): string {
	return `${progress.totalLines} line${progress.totalLines === 1 ? "" : "s"} ${progress.totalWords} word${progress.totalWords === 1 ? "" : "s"}`;
}

export async function writeTextWithProgress(
	absolutePath: string,
	content: string,
	signal: AbortSignal | undefined,
	onProgress?: (progress: WriteProgress) => void,
): Promise<WriteProgress> {
	let progress = createInitialWriteProgress(content);
	let lastUpdate = 0;
	let lineBreaksWritten = 0;
	let insideWord = false;

	const emit = (force = false) => {
		const now = Date.now();
		if (!force && now - lastUpdate < MIN_UPDATE_INTERVAL_MS) return;
		lastUpdate = now;
		onProgress?.({ ...progress });
	};

	emit(true);

	async function* chunks(): AsyncGenerator<string> {
		for (let offset = 0; offset < content.length; offset += WRITE_CHUNK_SIZE) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const chunk = content.slice(offset, offset + WRITE_CHUNK_SIZE);
			yield chunk;

			progress.phase = "writing";
			progress.writtenChars += chunk.length;
			lineBreaksWritten += (chunk.match(/\n/g) ?? []).length;
			progress.writtenLines = progress.writtenChars === 0 ? 0 : lineBreaksWritten + 1;

			const wordCount = countChunkWords(chunk, insideWord);
			insideWord = wordCount.insideWord;
			progress.writtenWords += wordCount.words;

			emit(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	await writeFile(absolutePath, chunks(), { encoding: "utf8", signal });
	progress = {
		...progress,
		phase: "done",
		writtenChars: content.length,
		writtenLines: progress.totalLines,
		writtenWords: progress.totalWords,
	};
	emit(true);
	return progress;
}
