import mysql from 'mysql2/promise';

const DB_CONFIG = {
	host: 'localhost',
	port: 13306,
	user: 'root',
	password: 'test1234',
	database: 'testdb',
};

let pool: mysql.Pool | null = null;

const getPool = (): mysql.Pool => {
	if (!pool) pool = mysql.createPool(DB_CONFIG);
	return pool;
};

export const closePool = async (): Promise<void> => {
	if (pool) {
		await pool.end();
		pool = null;
	}
};

/** 100+ 컬럼을 가진 테스트 테이블 생성 */
export const createTestTable = async (): Promise<void> => {
	const conn = await getPool().getConnection();
	try {
		await conn.execute('DROP TABLE IF EXISTS test_data');

		const cols = [
			'id bigint NOT NULL AUTO_INCREMENT',
			'key_col varchar(256) NOT NULL',
			...Array.from({ length: 50 }, (_, i) => `str_${i + 1} varchar(256)`),
			...Array.from({ length: 50 }, (_, i) => `num_${i + 1} decimal(13,3)`),
			'created_at datetime DEFAULT CURRENT_TIMESTAMP',
			'PRIMARY KEY (id)',
		];

		await conn.execute(`CREATE TABLE test_data (${cols.join(', ')})`);
		console.log('✅ Table created (102 columns)');
	} finally {
		conn.release();
	}
};

/** 컬럼 목록 (id 제외) */
export const COLUMNS = [
	'key_col',
	...Array.from({ length: 50 }, (_, i) => `str_${i + 1}`),
	...Array.from({ length: 50 }, (_, i) => `num_${i + 1}`),
	'created_at',
];

/** placeholder 생성 */
export const setPlaceholder = (insertQuery: string, params: unknown[][]): string => {
	const row = `(${params[0].map(() => '?').join(', ')})`;
	return `${insertQuery}${params.map(() => row).join(', ')}`;
};
