/**
 * Güncel TikTok hediye fiyatlarına (jeton/diamondCount * repeatCount) göre
 * sahaya çıkacak top sayısını mantıklı ve dengeli şekilde hesaplar.
 */
function calculateBallsForGift(diamondCount = 0, repeatCount = 0) {
  const unitDiamonds = Number(diamondCount);
  const repeats = Number(repeatCount);

  if (!Number.isFinite(unitDiamonds) || unitDiamonds <= 0 || !Number.isFinite(repeats) || repeats <= 0) {
    return {
      count: 0,
      totalDiamonds: 0
    };
  }

  const totalDiamonds = Math.round(unitDiamonds * repeats);

  let count;
  if (totalDiamonds <= 1) {
    count = 3; // Rose, TikTok, GG, Ice Cream Cone
  } else if (totalDiamonds <= 5) {
    count = 3 + Math.round((totalDiamonds - 1) * 1.75); // 5 jeton (Finger Heart) = 10 top
  } else if (totalDiamonds <= 30) {
    count = 10 + Math.round((totalDiamonds - 5) * 1.0); // 20 jeton = 25, 30 jeton (Doughnut) = 35 top
  } else if (totalDiamonds <= 100) {
    count = 35 + Math.round((totalDiamonds - 30) * 0.65); // 100 jeton (Hand Heart) = 81 top
  } else if (totalDiamonds <= 500) {
    count = 81 + Math.round((totalDiamonds - 100) * 0.30); // 500 jeton (Money Gun) = 201 top
  } else if (totalDiamonds <= 1000) {
    count = 201 + Math.round((totalDiamonds - 500) * 0.30); // 1000 jeton (Galaxy) = 351 top
  } else {
    count = 351 + Math.round((totalDiamonds - 1000) * 0.05);
  }

  return {
    count,
    totalDiamonds
  };
}

/**
 * Sohbet mesajında takım kodu/anahtar kelimesi geçip geçmediğini bulur.
 */
function resolveTeamFromChat(comment, chatKeywords) {
  if (!comment || typeof comment !== 'string' || !chatKeywords) return null;
  const normalized = comment.toLocaleLowerCase('tr-TR').trim();
  if (!normalized) return null;

  for (const [teamId, keywords] of Object.entries(chatKeywords)) {
    for (const kw of keywords) {
      const escaped = kw.toLocaleLowerCase('tr-TR').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[\\s.,!?@#])${escaped}($|[\\s.,!?@#])`, 'i');
      if (regex.test(normalized)) {
        return teamId;
      }
    }
  }
  return null;
}

module.exports = {
  calculateBallsForGift,
  resolveTeamFromChat
};
