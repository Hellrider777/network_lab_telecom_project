from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# --- GLOBAL CONFIGURATION ---
FREQS = [1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600]  # Digits 0 to 7
START_TONE = 3000  # Frame Start
STOP_TONE = 3400   # Frame Stop
TONE_DUR = 0.20     # 200 ms per tone


# --- HAMMING (7,4) ERROR CORRECTION ---
def encode_hamming74(bits4):
    d = [int(b) for b in bits4]
    p1 = d[0] ^ d[1] ^ d[3]
    p2 = d[0] ^ d[2] ^ d[3]
    p3 = d[1] ^ d[2] ^ d[3]
    return ''.join(str(b) for b in (p1, p2, d[0], p3, d[1], d[2], d[3]))


def decode_hamming74(bits7):
    b = [int(x) for x in bits7]
    s1 = b[0] ^ b[2] ^ b[4] ^ b[6]
    s2 = b[1] ^ b[2] ^ b[5] ^ b[6]
    s3 = b[3] ^ b[4] ^ b[5] ^ b[6]
    err_pos = s1 * 1 + s2 * 2 + s3 * 4  # 1-based error index

    corrected = b[:]
    if 0 < err_pos <= 7:
        corrected[err_pos - 1] ^= 1  # Flip erroneous bit back

    data_bits = ''.join(str(x) for x in (corrected[2], corrected[4], corrected[5], corrected[6]))
    return data_bits, err_pos - 1


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/config')
def config():
    return jsonify(freqs=FREQS, startTone=START_TONE, stopTone=STOP_TONE, toneDur=TONE_DUR)


# --- TRANSMITTER LOGIC ---
@app.route('/api/transmit', methods=['POST'])
def transmit():
    data = request.get_json(force=True)
    raw = (data.get('bits') or '').strip()
    err_idx = int(data.get('errIdx', -1))

    if not raw or any(c not in '01' for c in raw):
        return jsonify(error='Message must be a non-empty string of 0/1 bits'), 400

    # Pad message to multiple of 4 bits
    while len(raw) % 4 != 0:
        raw += '0'

    # 1. Hamming encode
    encoded = ''.join(encode_hamming74(raw[i:i + 4]) for i in range(0, len(raw), 4))

    # 2. Introduce medium error (flip the requested bit)
    bits = list(encoded)
    if 0 <= err_idx < len(bits):
        bits[err_idx] = '1' if bits[err_idx] == '0' else '0'
    final_bitstream = ''.join(bits)

    # 3. Convert bitstream into base-8 (3 bits = 1 octal tone symbol)
    while len(final_bitstream) % 3 != 0:
        final_bitstream += '0'

    sequence = [START_TONE]
    for i in range(0, len(final_bitstream), 3):
        octal_val = int(final_bitstream[i:i + 3], 2)
        sequence.append(FREQS[octal_val])
    sequence.append(STOP_TONE)

    return jsonify(sequence=sequence, encodedBits=encoded, finalBitstream=final_bitstream)


# --- RECEIVER LOGIC ---
@app.route('/api/receive', methods=['POST'])
def receive():
    data = request.get_json(force=True)
    octal_array = data.get('octalArray') or []

    raw_bitstream = ''.join(format(int(n), '03b') for n in octal_array)

    decoded_message = ''
    error_index = -1

    # Process in 7-bit Hamming blocks
    for i in range(0, len(raw_bitstream) - 6, 7):
        block = raw_bitstream[i:i + 7]
        data_bits, err_in_block = decode_hamming74(block)
        decoded_message += data_bits
        if err_in_block != -1:
            error_index = i + err_in_block

    return jsonify(decodedMessage=decoded_message, errorIndex=error_index)


if __name__ == '__main__':
    app.run(debug=True)
