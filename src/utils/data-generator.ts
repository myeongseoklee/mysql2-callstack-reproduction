import { COLUMNS } from './db.js';

export interface RowData {
	[key: string]: unknown;
}

const randomStr = (len: number): string => {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const randomNum = (): string => (Math.random() * 1000).toFixed(3);

export const generateRow = (): RowData => {
	const row: RowData = {
		key_col: `key_${randomStr(20)}`,
		created_at: new Date(),
	};

	for (let i = 1; i <= 50; i++) row[`str_${i}`] = randomStr(50);
	for (let i = 1; i <= 50; i++) row[`num_${i}`] = randomNum();

	return row;
};

export const generateRows = (count: number): RowData[] =>
	Array.from({ length: count }, generateRow);
