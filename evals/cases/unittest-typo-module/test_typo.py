import unittest

from helper2 import double


class TypoTest(unittest.TestCase):
    def test_doubles(self):
        self.assertEqual(double(2), 4)


if __name__ == "__main__":
    unittest.main()
