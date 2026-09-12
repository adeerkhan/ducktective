import unittest

from app import total


class TotalsTest(unittest.TestCase):
    def test_sums_every_row(self):
        # Raises inside app.py, so the traceback has two frames and the fault
        # site is the LAST one printed.
        self.assertEqual(total([1, 2, 3, 4]), 10)


if __name__ == "__main__":
    unittest.main()
