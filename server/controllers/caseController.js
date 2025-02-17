const { Case, User, CaseNote, CaseFile, CaseEvent } = require("../models");
const { generateCaseNumber } = require("../utils/caseUtils");
const { deleteFile } = require("../utils/fileUtils");
const notificationService = require('../services/notificationService');

const caseController = {
  createCase: async (req, res) => {
    try {
      console.log('Request body:', req.body);
      console.log('User:', req.user);
      const { title, description, clientId, caseType, courtDetails, filingDate } = req.body;
      const lawyerId = req.user.id; // Get lawyer ID from authenticated user

      // Validate required fields
      if (!title || !caseType || !clientId) {
        return res.status(400).json({
          message: "Title, case type, and client are required"
        });
      }

      // Verify the client exists and belongs to the lawyer
      const client = await User.findOne({
        where: { 
          id: clientId,
          role: 'client',
          lawyerId: lawyerId
        }
      });

      if (!client) {
        return res.status(404).json({
          message: "Client not found or not associated with this lawyer"
        });
      }

      // Generate unique case number
      const caseNumber = await generateCaseNumber();

      // Create the case
      const newCase = await Case.create({
        caseNumber,
        title,
        description,
        caseType,
        status: 'open',
        courtDetails,
        filingDate: filingDate || new Date(),
        lawyerId,
        clientId
      });

      // Fetch the created case with associated data
      const caseWithDetails = await Case.findByPk(newCase.id, {
        include: [
          {
            model: User,
            as: 'lawyer',
            attributes: ['id', 'name', 'email']
          },
          {
            model: User,
            as: 'client',
            attributes: ['id', 'name', 'email']
          }
        ]
      });

      res.status(201).json(caseWithDetails);
    } catch (error) {
      console.error('Detailed error:', error);
      console.error('Error creating case:', error);
      res.status(500).json({
        message: 'Failed to create case',
        error: error.message
      });
    }
  },

  getCases: async (req, res) => {
    try {
      let query = {};
      
      if (req.user.role === 'lawyer') {
        query.lawyerId = req.user.id;
      } else if (req.user.role === 'client') {
        query.clientId = req.user.id;
      }

      const cases = await Case.findAll({
        where: query,
        include: [
          { model: User, as: "lawyer", attributes: ['id', 'name', 'email'] },
          { model: User, as: "client", attributes: ['id', 'name', 'email'] }
        ],
        order: [['createdAt', 'DESC']]
      });

      res.status(200).json(cases);
    } catch (error) {
      console.error("Error getting cases:", error);
      res.status(500).json({ error: error.message });
    }
  },

  getCaseById: async (req, res) => {
    try {
      const caseItem = await Case.findByPk(req.params.id, {
        include: [
          { model: User, as: "lawyer", attributes: ['id', 'name', 'email'] },
          { model: User, as: "client", attributes: ['id', 'name', 'email'] },
          {
            model: CaseNote,
            as: 'notes',
            include: [{
              model: User,
              as: 'author',
              attributes: ['name']
            }]
          },
          { model: CaseFile, as: 'files' }
        ]
      });

      if (!caseItem) {
        return res.status(404).json({ error: "Case not found" });
      }

      // Check authorization
      if (req.user.role === 'lawyer' && caseItem.lawyerId !== req.user.id) {
        return res.status(403).json({ error: "Not authorized to view this case" });
      }
      if (req.user.role === 'client' && caseItem.clientId !== req.user.id) {
        return res.status(403).json({ error: "Not authorized to view this case" });
      }

      res.status(200).json(caseItem);
    } catch (error) {
      console.error("Error getting case:", error);
      res.status(500).json({ error: error.message });
    }
  },

  updateCase: async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      const caseItem = await Case.findByPk(id);

      if (!caseItem) {
        return res.status(404).json({ error: "Case not found" });
      }

      // Check authorization
      if (req.user.role === 'lawyer' && caseItem.lawyerId !== req.user.id) {
        return res.status(403).json({ error: "Not authorized to update this case" });
      }

      await caseItem.update(updates);

      // Add case note for the update
      await CaseNote.create({
        content: `Case updated: ${updates.status ? `Status changed to ${updates.status}` : 'Details updated'}`,
        type: 'general',
        createdBy: req.user.id,
        caseId: id
      });

      res.status(200).json({
        message: "Case updated successfully",
        case: caseItem
      });
    } catch (error) {
      console.error("Error updating case:", error);
      res.status(500).json({ error: error.message });
    }
  },

  deleteCase: async (req, res) => {
    try {
      const { id } = req.params;

      const caseItem = await Case.findByPk(id, {
        include: [{ model: CaseFile, as: 'files' }]
      });

      if (!caseItem) {
        return res.status(404).json({ error: "Case not found" });
      }

      // Check authorization
      if (req.user.role !== 'lawyer' || caseItem.lawyerId !== req.user.id) {
        return res.status(403).json({ error: "Not authorized to delete this case" });
      }

      // Delete associated files from storage
      for (const file of caseItem.files) {
        await deleteFile(file.filePath);
      }

      await caseItem.destroy();

      res.status(200).json({
        message: "Case deleted successfully"
      });
    } catch (error) {
      console.error("Error deleting case:", error);
      res.status(500).json({ error: error.message });
    }
  },

  addCaseEvent: async (req, res) => {
    try {
      const { caseId } = req.params;
      const { title, type, date, description } = req.body;

      // Verify case belongs to lawyer
      const case_ = await Case.findOne({
        where: { 
          id: caseId,
          lawyerId: req.user.id
        },
        include: [{
          model: User,
          as: 'client',
          attributes: ['id', 'email']
        }]
      });

      if (!case_) {
        return res.status(404).json({ 
          message: 'Case not found or unauthorized' 
        });
      }

      const event = await CaseEvent.create({
        title,
        type,
        date,
        description,
        caseId
      });

      // Schedule notification
      await notificationService.scheduleEventNotification({
        event,
        case: case_,
        client: case_.client,
        lawyer: req.user
      });

      res.status(201).json(event);
    } catch (error) {
      console.error('Error adding case event:', error);
      res.status(500).json({ 
        message: 'Failed to add case event',
        error: error.message 
      });
    }
  },

  getCaseTimeline: async (req, res) => {
    try {
      const { caseId } = req.params;

      const case_ = await Case.findOne({
        where: { 
          id: caseId,
          lawyerId: req.user.id
        },
        include: [{
          model: CaseEvent,
          as: 'events',
          order: [['date', 'ASC']]
        }]
      });

      if (!case_) {
        return res.status(404).json({ 
          message: 'Case not found or unauthorized' 
        });
      }

      res.json(case_.events);
    } catch (error) {
      console.error('Error fetching case timeline:', error);
      res.status(500).json({ 
        message: 'Failed to fetch case timeline',
        error: error.message 
      });
    }
  }
};

module.exports = caseController;
