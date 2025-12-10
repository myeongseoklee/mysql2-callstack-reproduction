/**
 * onResult 래핑 횟수 추적
 * dd-trace 버그 증명: 매 패킷마다 execute()가 호출되어 onResult가 재래핑됨
 *
 * 실행: npm run debug:wrap
 */

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

async function test(rowCount: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const conn = mysql2.createConnection(DB_CONFIG);
		const rows = generateRows(rowCount);
		const params = rows.map((row) => Object.values(row));
		const columns = Object.keys(rows[0]);

		const query = setPlaceholder(
			`INSERT IGNORE INTO test_data (${columns.join(', ')}) VALUES `,
			params
		);

		console.log(`\n📦 Testing ${rowCount} rows, ${params.flat().length} params`);

		conn.connect((err) => {
			if (err) return reject(err);

			// Prepare 명령의 execute() 호출 횟수 추적
			const origAddCommand = (conn as any).addCommand;
			let executeCallCount = 0;

			(conn as any).addCommand = function (cmd: any) {
				if (cmd.constructor.name === 'Prepare') {
					const origExecute = cmd.execute;
					cmd.execute = function (...args: any[]) {
						executeCallCount++;
						return origExecute.apply(this, args);
					};
				}
				return origAddCommand.apply(this, arguments);
			};

			conn.execute(query, params.flat(), (error) => {
				console.log(`   Prepare.execute() 호출: ${executeCallCount}회`);

				conn.end();

				if (error) {
					console.log(`   ❌ Error: ${error.message}`);
					reject(error);
				} else {
					console.log(`   ✅ Success`);
					resolve();
				}
			});
		});
	});
}

async function main() {
	console.log('🔍 Prepare.execute() 호출 횟수 추적\n');
	console.log('가설: Prepare.execute()가 params 수만큼 호출되고,');
	console.log('매 호출마다 onResult가 asyncResource.bind()로 재래핑됨\n');

	await createTestTable();

	try {
		await test(10);  // ~1020 params
		await test(20);  // ~2040 params
		await test(30);  // ~3060 params
		await test(33);  // ~3366 params - 임계점
	} catch (e) {
		console.log('\n🔥 임계점 도달 - Stack Overflow 발생');
	}

	await closePool();
}

main();
