async function runDirectTest() {
  const bits = document.getElementById('testBits').value.trim();
  const errIdx = Number.parseInt(document.getElementById('testError').value, 10);
  const status = document.getElementById('testStatus');

  if (!/^[01]{1,20}$/.test(bits)) {
    status.innerText = 'Status: Enter 1-20 binary bits';
    return;
  }

  status.innerText = 'Status: Transmitting...';
  const transmitResponse = await fetch('/api/transmit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bits, errIdx }),
  });
  const frame = await transmitResponse.json();
  if (!transmitResponse.ok) throw new Error(frame.error || 'Transmit failed');

  const symbols = [];
  for (let index = 0; index < frame.finalBitstream.length; index += 4) {
    symbols.push(Number.parseInt(frame.finalBitstream.slice(index, index + 4), 2));
  }

  status.innerText = 'Status: Receiving directly...';
  const receiveResponse = await fetch('/api/receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ octalArray: symbols }),
  });
  const result = await receiveResponse.json();
  if (!receiveResponse.ok) throw new Error(result.error || 'Receive failed');

  document.getElementById('expectedOutput').innerText = `Expected: ${bits} (${bits.length} bits)`;
  document.getElementById('encodedOutput').innerText = `Hamming encoded: ${frame.encodedBits} (${frame.encodedBits.length} bits)`;
  document.getElementById('symbolOutput').innerText = `Frequency symbols: ${symbols.join(', ')} (${symbols.length})`;
  document.getElementById('decodedOutput').innerText = `Decoded: ${result.decodedMessage} (${result.decodedMessage.length} bits), error index: ${result.errorIndex}`;

  const passed = result.decodedMessage === bits;
  document.getElementById('resultOutput').innerText = passed ? 'Result: PASS' : 'Result: FAIL';
  status.innerText = passed ? 'Status: Test complete' : 'Status: Test complete with mismatch';
}

document.getElementById('runTest').addEventListener('click', () => {
  runDirectTest().catch((error) => {
    document.getElementById('testStatus').innerText = `Status: ${error.message}`;
  });
});
