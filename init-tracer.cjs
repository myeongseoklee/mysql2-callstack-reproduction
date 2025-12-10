/**
 * dd-trace 초기화 (CommonJS)
 * --require 플래그로 먼저 로드
 */
const tracer = require('dd-trace');

tracer.init({
	service: 'mysql2-test',
	env: 'test',
	logInjection: false,
	profiling: false,
	runtimeMetrics: false,
	enabled: true,
});

console.log('🔍 dd-trace initialized (CommonJS)');
