import unittest

from app import total


class DoesNotReproduceTest(unittest.TestCase):
    """Encodes a call path where the fault never fires.

    Exists to prove the gate: a command that passes must yield
    ``does_not_reproduce`` and end the investigation with zero candidates — not
    a confident theory about ``total()``.
    """

    def test_bounded_range_is_fine(self):
        self.assertEqual(total([1, 2, 3, 4], 0, 2), 7)


if __name__ == "__main__":
    unittest.main()
