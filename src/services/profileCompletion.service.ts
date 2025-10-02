import { User, LawyerProfile } from '@prisma/client';

interface ProfileCompletionResult {
  score: number;
  percentage: number;
  missingFields: string[];
  completedFields: string[];
  maxPossibleScore: number;
}

interface UserWithProfile extends User {
  lawyerProfile?: LawyerProfile | null;
}

class ProfileCompletionService {
  private readonly fieldWeights = {
    // Required basic fields (20 points each)
    firstName: 20,
    lastName: 20,
    email: 20,

    // Optional basic fields (10 points each)
    phone: 10,
    bio: 10,
    profileImageUrl: 10,

    // Lawyer specific fields (10 points each)
    licenseNumber: 10,
    practiceAreas: 10,
    experience: 10,
    hourlyRate: 10,
  };

  /**
   * Calculate profile completion score
   */
  calculateCompletion(user: UserWithProfile): ProfileCompletionResult {
    const isLawyer = user.role === 'LAWYER';
    let score = 0;
    const completedFields: string[] = [];
    const missingFields: string[] = [];

    // Basic required fields
    const basicRequiredFields = ['firstName', 'lastName', 'email'];
    basicRequiredFields.forEach(field => {
      const value = user[field as keyof User];
      if (value && value.toString().trim()) {
        score += this.fieldWeights[field as keyof typeof this.fieldWeights];
        completedFields.push(field);
      } else {
        missingFields.push(field);
      }
    });

    // Basic optional fields
    const basicOptionalFields = ['phone', 'bio', 'profileImageUrl'];
    basicOptionalFields.forEach(field => {
      const value = user[field as keyof User];
      if (value && value.toString().trim()) {
        score += this.fieldWeights[field as keyof typeof this.fieldWeights];
        completedFields.push(field);
      } else {
        missingFields.push(field);
      }
    });

    // Lawyer specific fields
    if (isLawyer && user.lawyerProfile) {
      const lawyerFields = ['licenseNumber', 'experience', 'hourlyRate'];
      lawyerFields.forEach(field => {
        const value = user.lawyerProfile![field as keyof LawyerProfile];
        if (value !== null && value !== undefined && value.toString().trim()) {
          score += this.fieldWeights[field as keyof typeof this.fieldWeights];
          completedFields.push(`lawyer.${field}`);
        } else {
          missingFields.push(`lawyer.${field}`);
        }
      });

      // Practice areas (array field)
      if (user.lawyerProfile.practiceAreas && user.lawyerProfile.practiceAreas.length > 0) {
        score += this.fieldWeights.practiceAreas;
        completedFields.push('lawyer.practiceAreas');
      } else {
        missingFields.push('lawyer.practiceAreas');
      }
    }

    // Calculate maximum possible score
    const maxPossibleScore = this.getMaxPossibleScore(isLawyer);

    // Calculate percentage
    const percentage = Math.round((score / maxPossibleScore) * 100);

    return {
      score,
      percentage,
      missingFields,
      completedFields,
      maxPossibleScore
    };
  }

  /**
   * Get maximum possible score based on user type
   */
  private getMaxPossibleScore(isLawyer: boolean): number {
    const basicScore = 20 + 20 + 20 + 10 + 10 + 10; // firstName, lastName, email, phone, bio, profileImage
    const lawyerScore = isLawyer ? 10 + 10 + 10 + 10 : 0; // license, practiceAreas, experience, hourlyRate
    return basicScore + lawyerScore;
  }

  /**
   * Get field suggestions for improvement
   */
  getFieldSuggestions(user: UserWithProfile): string[] {
    const completion = this.calculateCompletion(user);
    const suggestions: string[] = [];

    completion.missingFields.forEach(field => {
      switch (field) {
        case 'firstName':
          suggestions.push('Add your first name to personalize your profile');
          break;
        case 'lastName':
          suggestions.push('Add your last name to complete your identity');
          break;
        case 'email':
          suggestions.push('Verify your email address');
          break;
        case 'phone':
          suggestions.push('Add your phone number for better communication');
          break;
        case 'bio':
          suggestions.push('Write a brief bio to tell others about yourself');
          break;
        case 'profileImageUrl':
          suggestions.push('Upload a profile photo to make your profile more personal');
          break;
        case 'lawyer.licenseNumber':
          suggestions.push('Add your lawyer license number for verification');
          break;
        case 'lawyer.practiceAreas':
          suggestions.push('List your areas of legal practice');
          break;
        case 'lawyer.experience':
          suggestions.push('Add your years of legal experience');
          break;
        case 'lawyer.hourlyRate':
          suggestions.push('Set your hourly consultation rate');
          break;
        default:
          suggestions.push(`Complete the ${field} field`);
      }
    });

    return suggestions;
  }

  /**
   * Get completion level description
   */
  getCompletionLevel(percentage: number): string {
    if (percentage >= 90) return 'Excellent';
    if (percentage >= 75) return 'Very Good';
    if (percentage >= 50) return 'Good';
    if (percentage >= 25) return 'Fair';
    return 'Needs Improvement';
  }

  /**
   * Check if profile meets minimum requirements
   */
  meetsMinimumRequirements(user: UserWithProfile): boolean {
    const hasBasicInfo = !!(user.firstName && user.lastName && user.email && user.phone);

    if (user.role === 'LAWYER') {
      const lawyerProfile = user.lawyerProfile;
      const hasLawyerInfo = !!(lawyerProfile &&
        lawyerProfile.licenseNumber &&
        lawyerProfile.practiceAreas.length > 0);
      return hasBasicInfo && hasLawyerInfo;
    }

    return hasBasicInfo;
  }
}

export default new ProfileCompletionService();