import { get } from 'svelte/store';
import { audioEnabled } from './settings.ts';
export type SoundName = 'move' | 'confirm' | 'back' | 'welcome' | 'exit';
let audioContext: AudioContext | null = null;

export function initAudio(): void {
	if (!audioContext) audioContext = new AudioContext();
	if (audioContext.state === 'suspended') audioContext.resume();
}

export function play(name: SoundName): void {
	if (!get(audioEnabled)) return;
	if (!audioContext) initAudio();
	if (!audioContext) return;
	switch (name) {
		case 'move':
			playMove();
			break;
		case 'confirm':
			playConfirm();
			break;
		case 'back':
			playBack();
			break;
		case 'welcome':
			playWelcome();
			break;
		case 'exit':
			playExit();
			break;
	}
}

function playMove(): void {
	if (!audioContext) return;
	const osc = audioContext.createOscillator();
	const gain = audioContext.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(600, audioContext.currentTime);
	osc.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.05);
	gain.gain.setValueAtTime(0.15, audioContext.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.05);
	osc.connect(gain);
	gain.connect(audioContext.destination);
	osc.start();
	osc.stop(audioContext.currentTime + 0.05);
}

function playConfirm(): void {
	if (!audioContext) return;
	const osc = audioContext.createOscillator();
	const gain = audioContext.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(400, audioContext.currentTime);
	osc.frequency.exponentialRampToValueAtTime(800, audioContext.currentTime + 0.1);
	gain.gain.setValueAtTime(0.2, audioContext.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
	osc.connect(gain);
	gain.connect(audioContext.destination);
	osc.start();
	osc.stop(audioContext.currentTime + 0.15);
}

function playBack(): void {
	if (!audioContext) return;
	const osc = audioContext.createOscillator();
	const gain = audioContext.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(400, audioContext.currentTime);
	osc.frequency.exponentialRampToValueAtTime(200, audioContext.currentTime + 0.1);
	gain.gain.setValueAtTime(0.15, audioContext.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
	osc.connect(gain);
	gain.connect(audioContext.destination);
	osc.start();
	osc.stop(audioContext.currentTime + 0.12);
}

function playWelcome(): void {
	if (!audioContext) return;
	// Arpeggio up: C5, E5, G5, C6
	const notes = [523.25, 659.25, 783.99, 1046.5];
	const noteLength = 0.1;
	const gap = 0.08;
	notes.forEach((freq, i) => {
		const osc = audioContext!.createOscillator();
		const gain = audioContext!.createGain();
		const startTime = audioContext!.currentTime + i * (noteLength + gap);
		osc.type = 'sine';
		osc.frequency.setValueAtTime(freq, startTime);
		gain.gain.setValueAtTime(0, startTime);
		gain.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.001, startTime + noteLength);
		osc.connect(gain);
		gain.connect(audioContext!.destination);
		osc.start(startTime);
		osc.stop(startTime + noteLength);
	});
}

function playExit(): void {
	if (!audioContext) return;
	// Descending sweep
	const osc = audioContext.createOscillator();
	const gain = audioContext.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(800, audioContext.currentTime);
	osc.frequency.exponentialRampToValueAtTime(100, audioContext.currentTime + 0.5);
	gain.gain.setValueAtTime(0.2, audioContext.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
	osc.connect(gain);
	gain.connect(audioContext.destination);
	osc.start();
	osc.stop(audioContext.currentTime + 0.5);
}
