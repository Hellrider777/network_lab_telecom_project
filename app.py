from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# 9 tones instead of 8: differential encoding forbids a "no change" step
# (see transmit()), leaving exactly 8 valid non-zero steps around a 9-tone
# circle — log2(8) = 3 bits/tone, the same rate as plain absolute encoding,
# with no dedicated sync tone needed since every step guarantees a change.
# This differential tone mapping is always used, regardless of the `legacy`
# flag below — legacy only switches the Hamming block layout.
FREQS = [1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800]
START_TONE = 3000
STOP_TONE = 3400
TONE_DUR = 0.20

# Number of Hamming(7,4) blocks per interleave group. Differential decoding
# turns one mis-heard tone into two consecutive corrupted 3-bit chunks (see
# interleave_blocks below); a depth of 6 spaces same-block bits far enough
# apart that a corrupted 6-bit (2-tone) window can never touch one block twice.
INTERLEAVE_DEPTH = 6


def encode_hamming74(bits4):
    # Encodes 4 data bits into 7-bit Hamming code
    d = [int(b) for b in bits4]
    p1 = d[0] ^ d[1] ^ d[3]
    p2 = d[0] ^ d[2] ^ d[3]
    p3 = d[1] ^ d[2] ^ d[3]
    return ''.join(str(b) for b in (p1, p2, d[0], p3, d[1], d[2], d[3]))


def decode_hamming74(bits7):
    # Decodes 7-bit Hamming code and corrects single-bit errors
    b = [int(x) for x in bits7]
    s1 = b[0] ^ b[2] ^ b[4] ^ b[6]
    s2 = b[1] ^ b[2] ^ b[5] ^ b[6]
    s3 = b[3] ^ b[4] ^ b[5] ^ b[6]
    err_pos = s1 * 1 + s2 * 2 + s3 * 4

    corrected = b[:]
    if 0 < err_pos <= 7:
        corrected[err_pos - 1] ^= 1

    data_bits = ''.join(str(x) for x in (corrected[2], corrected[4], corrected[5], corrected[6]))
    return data_bits, err_pos - 1


def interleave_blocks(blocks):
    # Column-major reorder: bit i of every block, then bit i+1 of every
    # block, etc. Bits from the same original block end up spaced
    # len(blocks) positions apart in the output instead of adjacent.
    return ''.join(''.join(block[col] for block in blocks) for col in range(7))


def deinterleave_bits(bits, depth):
    # Inverse of interleave_blocks: reconstructs `depth` 7-bit codewords
    # from a column-major-interleaved bitstream of length depth*7.
    blocks = [''] * depth
    idx = 0
    for _col in range(7):
        for row in range(depth):
            blocks[row] += bits[idx]
            idx += 1
    return blocks


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/config')
def config():
    return jsonify(freqs=FREQS, startTone=START_TONE, stopTone=STOP_TONE, toneDur=TONE_DUR)


@app.route('/api/transmit', methods=['POST'])
def transmit():
    # Encodes message with Hamming(7,4) blocks, laid out either interleaved
    # (default — protects against differential decoding's error-doubling)
    # or plain/legacy (the original block-per-block layout, for comparison),
    # then maps the result onto the same differential 9-ary tone sequence.
    data = request.get_json(force=True)
    raw = (data.get('bits') or '').strip()
    err_idx = int(data.get('errIdx', -1))
    legacy = bool(data.get('legacy'))

    if not raw or any(c not in '01' for c in raw):
        return jsonify(error='Message must be a non-empty string of 0/1 bits'), 400

    while len(raw) % 4 != 0:
        raw += '0'

    if legacy:
        encoded = ''.join(encode_hamming74(raw[i:i + 4]) for i in range(0, len(raw), 4))
    else:
        hamming_blocks = [encode_hamming74(raw[i:i + 4]) for i in range(0, len(raw), 4)]
        while len(hamming_blocks) % INTERLEAVE_DEPTH != 0:
            hamming_blocks.append(encode_hamming74('0000'))
        encoded = ''.join(
            interleave_blocks(hamming_blocks[i:i + INTERLEAVE_DEPTH])
            for i in range(0, len(hamming_blocks), INTERLEAVE_DEPTH)
        )

    bits = list(encoded)
    if 0 <= err_idx < len(bits):
        bits[err_idx] = '1' if bits[err_idx] == '0' else '0'
    final_bitstream = ''.join(bits)

    while len(final_bitstream) % 3 != 0:
        final_bitstream += '0'

    # 9-ary differential mapping: each 3-bit chunk (0-7) selects a non-zero
    # step (1-8) around the 9-tone circle, so consecutive tones are always
    # different — no dedicated sync tone required, in either layout mode.
    n = len(FREQS)
    index = 0  # reference point the receiver also starts from
    sequence = [START_TONE]
    for i in range(0, len(final_bitstream), 3):
        step = int(final_bitstream[i:i + 3], 2) + 1
        index = (index + step) % n
        sequence.append(FREQS[index])
    sequence.append(STOP_TONE)

    return jsonify(sequence=sequence, encodedBits=encoded, finalBitstream=final_bitstream)


@app.route('/api/receive', methods=['POST'])
def receive():
    # Recovers steps from consecutive tone indices (always differential),
    # then decodes Hamming blocks using whichever layout matches how they
    # were sent (interleaved by default, or plain/legacy).
    data = request.get_json(force=True)
    tone_indices = data.get('toneIndices') or []
    legacy = bool(data.get('legacy'))

    n = len(FREQS)
    raw_bitstream = ''
    prev = 0
    for idx in tone_indices:
        step = (int(idx) - prev) % n
        # step should always be 1-8 by construction; guard against a stray
        # step=0 from a genuine misdetected/duplicate tone read
        value = (step - 1) % 8
        raw_bitstream += format(value, '03b')
        prev = int(idx)

    decoded_message = ''
    error_index = -1

    if legacy:
        block_num = 0
        for i in range(0, len(raw_bitstream) - 6, 7):
            block = raw_bitstream[i:i + 7]
            data_bits, err_in_block = decode_hamming74(block)
            decoded_message += data_bits
            if err_in_block != -1:
                error_index = block_num * 4  # index into decodedMessage, not the raw 7-bit stream
            block_num += 1
    else:
        group_bits = 7 * INTERLEAVE_DEPTH
        block_num = 0
        for g in range(0, len(raw_bitstream) - group_bits + 1, group_bits):
            group = raw_bitstream[g:g + group_bits]
            blocks = deinterleave_bits(group, INTERLEAVE_DEPTH)
            for block in blocks:
                data_bits, err_in_block = decode_hamming74(block)
                decoded_message += data_bits
                if err_in_block != -1:
                    error_index = block_num * 4
                block_num += 1

    return jsonify(decodedMessage=decoded_message, errorIndex=error_index)


if __name__ == '__main__':
    app.run(debug=True)
