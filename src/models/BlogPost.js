const mongoose = require("mongoose");

const BlogPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    excerpt: { type: String, default: "", trim: true },
    content: { type: String, default: "" },
    originalLanguage: { type: String, default: "en", lowercase: true, trim: true },
    translations: {
      type: Map,
      of: new mongoose.Schema(
        {
          title: { type: String, default: "", trim: true },
          excerpt: { type: String, default: "", trim: true },
          content: { type: String, default: "" },
        },
        { _id: false }
      ),
      default: {},
    },
    category: { type: String, default: "Education", trim: true },
    tags: [{ type: String, trim: true }],
    coverImageUrl: { type: String, default: "", trim: true },
    coverImageAlt: { type: String, default: "", trim: true },
    links: [
      {
        label: { type: String, default: "", trim: true },
        url: { type: String, default: "", trim: true },
      },
    ],
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    featured: { type: Boolean, default: false },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    authorName: { type: String, default: "", trim: true },
    publishedAt: { type: Date },
    metrics: {
      claps: { type: Number, default: 0, min: 0 },
      shares: { type: Number, default: 0, min: 0 },
      views: { type: Number, default: 0, min: 0 },
      readMs: { type: Number, default: 0, min: 0 },
      readEvents: { type: Number, default: 0, min: 0 },
      engagedReads: { type: Number, default: 0, min: 0 },
      maxScrollPercent: { type: Number, default: 0, min: 0, max: 100 },
    },
    clappedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    comments: [
      {
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        authorName: { type: String, default: "", trim: true },
        authorInitials: { type: String, default: "", trim: true },
        text: { type: String, default: "", trim: true },
        edited: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

BlogPostSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
BlogPostSchema.index({ category: 1, status: 1 });
BlogPostSchema.index({ title: "text", excerpt: "text", content: "text", tags: "text" });

module.exports = mongoose.model("BlogPost", BlogPostSchema);
