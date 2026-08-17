"""Round-trip test pipeline for app.py's encode/decode chain.

Exercises the real transmit()/receive() Flask route functions end-to-end —
bits -> Hamming(7,4) (+ interleaving, unless legacy) -> differential 9-ary
tone sequence -> simulated acoustic channel -> tone sequence -> decode ->
bits — and asserts the round trip is an identity mapping on the message,
and that the reported error index correctly localizes an injected single-bit
error. Covers both the default (interleaved) and legacy (plain block) modes.

Run with: python3 test_app.py
"""
import random
import unittest

import app as appmod


def transmit(raw, err_idx=-1, legacy=False):
    with appmod.app.test_request_context(json={'bits': raw, 'errIdx': err_idx, 'legacy': legacy}):
        resp = appmod.transmit()
        # transmit() returns either a Response, or an (error_response, status) tuple
        if isinstance(resp, tuple):
            resp = resp[0]
        return resp.get_json()


def receive(tone_indices, legacy=False):
    with appmod.app.test_request_context(json={'toneIndices': tone_indices, 'legacy': legacy}):
        return appmod.receive().get_json()


def freq_sequence_to_tone_indices(sequence):
    # Drop START/STOP and map each frequency back to its FREQS index,
    # exactly as the receiver's JS does client-side.
    return [appmod.FREQS.index(f) for f in sequence[1:-1]]


def pad4(raw):
    while len(raw) % 4 != 0:
        raw += '0'
    return raw


def run_pipeline(raw, err_idx=-1, legacy=False):
    """Full transmit -> simulated channel -> receive round trip."""
    tx = transmit(raw, err_idx, legacy)
    assert 'sequence' in tx, f'transmit failed: {tx}'
    tone_indices = freq_sequence_to_tone_indices(tx['sequence'])
    rx = receive(tone_indices, legacy)
    return tx, rx


def expected_block_legacy(err_idx):
    return err_idx // 7


def expected_block_interleaved(err_idx):
    # Mirrors interleave_blocks' column-major reorder: bit `within` of
    # group `group` originated from row (=block) `within % depth`.
    group_bits = 7 * appmod.INTERLEAVE_DEPTH
    group, within = divmod(err_idx, group_bits)
    _col, row = divmod(within, appmod.INTERLEAVE_DEPTH)
    return group * appmod.INTERLEAVE_DEPTH + row


MESSAGE_LENGTHS = [4, 7, 8, 12, 20, 24, 31, 40, 80]


class TestConfig(unittest.TestCase):
    def test_config_fields(self):
        with appmod.app.test_request_context():
            cfg = appmod.config().get_json()
        for key in ('freqs', 'startTone', 'stopTone', 'toneDur'):
            self.assertIn(key, cfg)
        self.assertEqual(len(cfg['freqs']), 9)


class TestDifferentialTones(unittest.TestCase):
    def test_no_adjacent_tone_repeats(self):
        # The point of differential encoding: consecutive tones must always
        # differ (in both modes), so the receiver never needs a sync tone.
        for legacy in (False, True):
            for length in MESSAGE_LENGTHS:
                with self.subTest(legacy=legacy, length=length):
                    raw = '0' * length  # worst case for absolute encoding: constant repeats
                    tx = transmit(raw, -1, legacy)
                    seq = tx['sequence'][1:-1]
                    for a, b in zip(seq, seq[1:]):
                        self.assertNotEqual(a, b)


class TestRoundTripNoError(unittest.TestCase):
    def test_identity_no_error(self):
        for legacy in (False, True):
            for length in MESSAGE_LENGTHS:
                with self.subTest(legacy=legacy, length=length):
                    raw = ''.join(random.choice('01') for _ in range(length))
                    _tx, rx = run_pipeline(raw, -1, legacy)
                    expected = pad4(raw)
                    self.assertEqual(rx['decodedMessage'][:len(expected)], expected)
                    self.assertEqual(rx['errorIndex'], -1)


class TestSingleBitErrorCorrection(unittest.TestCase):
    def test_identity_with_single_bit_error(self):
        for legacy in (False, True):
            for length in [8, 20, 24, 40, 80]:
                raw = ''.join(random.choice('01') for _ in range(length))
                expected = pad4(raw)
                encoded_len = len(transmit(raw, -1, legacy)['encodedBits'])
                step = max(1, encoded_len // 12)
                for err_idx in range(0, encoded_len, step):
                    with self.subTest(legacy=legacy, length=length, err_idx=err_idx):
                        _tx, rx = run_pipeline(raw, err_idx, legacy)
                        self.assertEqual(
                            rx['decodedMessage'][:len(expected)], expected,
                            'Hamming correction failed to recover a single-bit error'
                        )

    def test_error_index_localizes_correct_block(self):
        raw = '0' * 80
        expected = pad4(raw)
        for legacy in (False, True):
            encoded_len = len(transmit(raw, -1, legacy)['encodedBits'])
            expect_fn = expected_block_legacy if legacy else expected_block_interleaved
            for err_idx in range(0, encoded_len, 3):
                with self.subTest(legacy=legacy, err_idx=err_idx):
                    _tx, rx = run_pipeline(raw, err_idx, legacy)
                    self.assertEqual(rx['decodedMessage'][:len(expected)], expected)
                    got_block = rx['errorIndex'] // 4
                    self.assertEqual(got_block, expect_fn(err_idx))


class TestEdgeCases(unittest.TestCase):
    def test_empty_message_rejected(self):
        tx = transmit('', -1)
        self.assertNotIn('sequence', tx)

    def test_invalid_bits_rejected(self):
        tx = transmit('01029', -1)
        self.assertNotIn('sequence', tx)

    def test_empty_tone_array_receive(self):
        rx = receive([])
        self.assertEqual(rx['decodedMessage'], '')
        self.assertEqual(rx['errorIndex'], -1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
