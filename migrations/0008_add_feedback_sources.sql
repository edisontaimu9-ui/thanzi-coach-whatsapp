-- "See details": the References block of an answer is hidden from the main message and stored here
-- (truncated) so a tap on the 📚 See details button can reveal it (see src/feedback.js).
ALTER TABLE feedback ADD COLUMN sources TEXT;
