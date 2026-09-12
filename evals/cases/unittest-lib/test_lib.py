import unittest

from lib import label


class LabelTest(unittest.TestCase):
    def test_uppercases(self):
        self.assertEqual(label({"nom": "ada"}), "ADA")


if __name__ == "__main__":
    unittest.main()
