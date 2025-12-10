/**
 * MySQL2 + dd-trace Call Stack Overflow PoC
 *
 * 실행: npm run reproduce
 */

import { Transform, Readable } from 'stream';
import mysql2 from 'mysql2';
import { createTestTable, closePool, COLUMNS, setPlaceholder } from './utils/db.js';
import { generateRows, type RowData } from './utils/data-generator.js';

const DB_CONFIG = {
	host: 'localhost',
	port: 13306,
	user: 'root',
	password: 'test1234',
	database: 'testdb',
};

/** 문제가 발생하는 코드 패턴: params.flat()을 execute에 전달 */
const bulkInsert = (
	entries: RowData[],
	connection: mysql2.Connection,
	callback: (error: Error | null) => void
): void => {
	const columns = Object.keys(entries[0]);
	const params = entries.map((row) => Object.values(row));
	const query = setPlaceholder(
		`INSERT IGNORE INTO test_data (${columns.join(', ')}) VALUES `,
		params
	);
	connection.execute(query, params.flat(), callback);
};

function createDataStream(count: number): Readable {
	const rows = generateRows(count);
	let i = 0;
	return new Readable({
		objectMode: true,
		read() {
			this.push(i < rows.length ? rows[i++] : null);
		},
	});
}

async function test(rowCount: number): Promise<{ success: boolean; error?: Error }> {
	return new Promise((resolve) => {
		const conn = mysql2.createConnection(DB_CONFIG);
		let batchSize = 10;
		let batch: RowData[] = [];

		conn.connect((err) => {
			if (err) return resolve({ success: false, error: err });

			const batchStream = new Transform({
				objectMode: true,
				transform(row: RowData, _, cb) {
					batch.push(row);
					if (batch.length >= batchSize) {
						batchSize = Math.min(500, Math.floor(batchSize / 0.8));
						this.push([...batch]);
						batch = [];
					}
					cb();
				},
				flush(cb) {
					if (batch.length) this.push([...batch]);
					cb();
				},
			});

			const insertStream = new Transform({
				objectMode: true,
				transform(rows: RowData[], _, cb) {
					bulkInsert(rows, conn, (error) => {
						if (error) {
							console.error(`\n🔥 ERROR! Batch: ${rows.length}, Params: ${rows.length * COLUMNS.length}`);
							console.error(error.stack);
							resolve({ success: false, error });
							return;
						}
						cb();
					});
				},
			});

			createDataStream(rowCount)
				.pipe(batchStream)
				.pipe(insertStream)
				.on('finish', () => { conn.end(); resolve({ success: true }); })
				.on('error', (e) => { conn.end(); resolve({ success: false, error: e }); });
		});
	});
}

async function main() {
	console.log('🔥 MySQL2 + dd-trace Call Stack Overflow PoC\n');

	await createTestTable();
	console.log(`Columns: ${COLUMNS.length}\n`);

	for (const rows of [100, 500, 1000, 2000]) {
		console.log(`Testing ${rows} rows...`);
		const { success, error } = await test(rows);

		if (!success) {
			console.log('\n❌ Error reproduced!');
			break;
		}
		console.log('✅ Success\n');
	}

	await closePool();
}

main();
